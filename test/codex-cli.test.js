'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { z } = require('zod');

const codex = require('../lib/codex-cli');
const bridge = require('../lib/codex-cli/bridge');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-test-'));

// ── model ids ────────────────────────────────────────────────────────────

test('isCodexCliModel / modelId', () => {
  assert.strictEqual(codex.isCodexCliModel('codex-cli/gpt-5.5'), true);
  assert.strictEqual(codex.isCodexCliModel('codex/gpt-5.5'), false);
  assert.strictEqual(codex.isCodexCliModel('openai/gpt-5.5'), false);
  assert.strictEqual(codex.isCodexCliModel(null), false);
  assert.strictEqual(codex.modelId('codex-cli/gpt-6-sol'), 'gpt-6-sol');
});

// ── sandbox ──────────────────────────────────────────────────────────────

test('sandboxFor: read/none scopes are read-only; default is full access; env override honoured', () => {
  assert.strictEqual(codex.sandboxFor({ toolScope: 'read', env: {} }), 'read-only');
  assert.strictEqual(codex.sandboxFor({ toolScope: 'none', env: { HUB_CODEX_SANDBOX: 'danger-full-access' } }), 'read-only');
  assert.strictEqual(codex.sandboxFor({ env: {} }), 'danger-full-access');
  assert.strictEqual(codex.sandboxFor({ toolScope: 'full', env: { HUB_CODEX_SANDBOX: 'workspace-write' } }), 'workspace-write');
  assert.strictEqual(codex.sandboxFor({ env: { HUB_CODEX_SANDBOX: 'bogus' } }), 'danger-full-access');
});

// ── argv ─────────────────────────────────────────────────────────────────

test('buildArgs: fresh turn with bridge, instructions and images', () => {
  const args = codex.buildArgs({
    model: 'gpt-5.5', cwd: '/ws', sandbox: 'danger-full-access',
    instructions: 'Be "Maestro"\nline2', bridge: { file: '/d/b.json' }, images: ['/a.png'], nodePath: '/usr/bin/node',
  });
  assert.deepStrictEqual(args.slice(0, 5), ['exec', '--json', '--skip-git-repo-check', '-m', 'gpt-5.5']);
  assert.ok(args.includes('-C') && args[args.indexOf('-C') + 1] === '/ws');
  assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(args.includes('developer_instructions="Be \\"Maestro\\"\\nline2"'));
  assert.ok(args.includes('mcp_servers.agent-hub.command="/usr/bin/node"'));
  assert.ok(args.includes(`mcp_servers.agent-hub.args=[${JSON.stringify(codex.MCP_BRIDGE_SCRIPT)}]`));
  assert.ok(args.includes('mcp_servers.agent-hub.env={HUB_CODEX_BRIDGE_FILE="/d/b.json"}'));
  assert.ok(args.includes('-i') && args[args.indexOf('-i') + 1] === '/a.png');
  assert.strictEqual(args[args.length - 1], '-');
});

test('buildArgs: resume has no -C, sandbox goes through config', () => {
  const args = codex.buildArgs({ model: 'gpt-5.5', resumeId: 'th-1', cwd: '/ws', sandbox: 'read-only' });
  assert.deepStrictEqual(args.slice(0, 3), ['exec', 'resume', 'th-1']);
  assert.ok(!args.includes('-C'));
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(args.includes('sandbox_mode="read-only"'));
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(!args.some(a => a.startsWith('mcp_servers')));
});

// ── events ───────────────────────────────────────────────────────────────

test('parseLine ignores noise', () => {
  assert.strictEqual(codex.parseLine(''), null);
  assert.strictEqual(codex.parseLine('Reading prompt from stdin...'), null);
  assert.strictEqual(codex.parseLine('{bad json'), null);
  assert.deepStrictEqual(codex.parseLine(' {"type":"turn.started"} '), { type: 'turn.started' });
});

test('eventToActions maps the codex exec --json stream', () => {
  const E = codex.eventToActions;
  assert.deepStrictEqual(E({ type: 'thread.started', thread_id: 't1' }), [{ kind: 'session', id: 't1' }]);
  assert.deepStrictEqual(E({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }), [{ kind: 'text', text: 'hi' }]);
  assert.deepStrictEqual(E({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls' } }),
    [{ kind: 'tool_start', id: 'i1', tool: 'Bash', input: 'ls' }]);
  const [r] = E({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'false', aggregated_output: 'x', exit_code: 1 } });
  assert.strictEqual(r.kind, 'tool_result'); assert.strictEqual(r.output, 'exit 1\nx');
  const [m] = E({ type: 'item.started', item: { id: 'i2', type: 'mcp_tool_call', server: 'agent-hub', tool: 'read_memory', arguments: { section: 'general' } } });
  assert.strictEqual(m.tool, 'read_memory'); assert.strictEqual(m.input, 'general');
  const [o] = E({ type: 'item.started', item: { id: 'i3', type: 'mcp_tool_call', server: 'other', tool: 'x', arguments: {} } });
  assert.strictEqual(o.tool, 'other__x');
  const [mr] = E({ type: 'item.completed', item: { id: 'i2', type: 'mcp_tool_call', server: 'agent-hub', tool: 'read_memory', result: { content: [{ type: 'text', text: 'mem' }] } } });
  assert.strictEqual(mr.output, 'mem');
  const [me] = E({ type: 'item.completed', item: { id: 'i2', type: 'mcp_tool_call', server: 'agent-hub', tool: 't', error: { message: 'boom' } } });
  assert.strictEqual(me.output, 'Error: boom');
  assert.deepStrictEqual(E({ type: 'item.started', item: { type: 'reasoning' } }), [{ kind: 'thinking' }]);
  assert.deepStrictEqual(E({ type: 'turn.completed', usage: { input_tokens: 5 } }), [{ kind: 'usage', usage: { input_tokens: 5 } }]);
  assert.deepStrictEqual(E({ type: 'turn.failed', error: { message: 'quota' } }), [{ kind: 'error', message: 'quota' }]);
  assert.deepStrictEqual(E({ type: 'item.completed', item: { type: 'error', message: 'warn' } }), [{ kind: 'error', message: 'warn', soft: true }]);
  assert.deepStrictEqual(E({ type: 'turn.started' }), []);
  assert.deepStrictEqual(E(null), []);
});

// ── session map ──────────────────────────────────────────────────────────

test('session map is per agent and per model', () => {
  const file = path.join(tmp(), 'sessions.json');
  assert.strictEqual(codex.getSession('a', 'gpt-5.5', file), null);
  codex.setSession('a', 'th-1', 'gpt-5.5', file);
  assert.strictEqual(codex.getSession('a', 'gpt-5.5', file), 'th-1');
  assert.strictEqual(codex.getSession('a', 'gpt-6-sol', file), null, 'model switch starts fresh');
  assert.strictEqual(codex.getSession('b', 'gpt-5.5', file), null);
  codex.clearSession('a', file);
  assert.strictEqual(codex.getSession('a', 'gpt-5.5', file), null);
});

// ── binary, login, discovery (fake codex) ────────────────────────────────

function fakeCodex(dir, { loggedIn = true } = {}) {
  const bin = path.join(dir, 'codex');
  const models = { models: [
    { slug: 'gpt-hidden', visibility: 'hide', priority: 0 },
    { slug: 'gpt-b', display_name: 'B', priority: 2, context_window: 272000 },
    { slug: 'gpt-a', display_name: 'A', description: 'first', priority: 1 },
  ] };
  fs.writeFileSync(bin, `#!/bin/sh
if [ "$1" = "login" ]; then ${loggedIn ? 'echo "Logged in using ChatGPT"; exit 0' : 'echo "Not logged in" >&2; exit 1'}; fi
if [ "$1" = "debug" ]; then echo '${JSON.stringify(models)}'; exit 0; fi
exit 2
`, { mode: 0o755 });
  return bin;
}

test('resolveBinary: CODEX_CLI_PATH, npm-global, PATH, missing', () => {
  const d = tmp(); const bin = fakeCodex(d);
  assert.strictEqual(codex.resolveBinary({ CODEX_CLI_PATH: bin }), bin);
  assert.strictEqual(codex.resolveBinary({ CODEX_CLI_PATH: path.join(d, 'nope') }), null);
  const home = tmp(); fs.mkdirSync(path.join(home, '.npm-global', 'bin'), { recursive: true });
  const g = fakeCodex(path.join(home, '.npm-global', 'bin'));
  assert.strictEqual(codex.resolveBinary({ HOME: home, PATH: '' }), g);
  assert.strictEqual(codex.resolveBinary({ HOME: tmp(), PATH: d }), bin);
});

test('loginStatus + discoverModels against a fake CLI', async () => {
  const bin = fakeCodex(tmp());
  const st = await codex.loginStatus({ bin });
  assert.deepStrictEqual([st.installed, st.loggedIn, st.mode], [true, true, 'chatgpt']);
  const models = await codex.discoverModels({ bin });
  assert.deepStrictEqual(models.map(m => m.id), ['gpt-a', 'gpt-b']);
  assert.strictEqual(models[1].contextWindow, 272000);
  const out = fakeCodex(tmp(), { loggedIn: false });
  assert.strictEqual((await codex.loginStatus({ bin: out })).loggedIn, false);
  assert.deepStrictEqual(await codex.discoverModels({ bin: out }), []);
});

// ── bridge ───────────────────────────────────────────────────────────────

function sampleTools(calls) {
  const t = bridge.collectingSdk.tool;
  const srv = bridge.collectingSdk.createSdkMcpServer({ name: 'agent-hub', tools: [
    t('echo', 'Echo text', { text: z.string() }, async (a) => { calls.push(a); return { content: [{ type: 'text', text: `echo:${a.text}` }] }; }),
    t('boom', 'Throws', {}, async () => { throw new Error('kaput'); }),
  ] });
  return srv.tools;
}

function startHub() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === bridge.ROUTE) return bridge.handle(req, res);
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function post(url, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url + bridge.ROUTE); const payload = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers[bridge.TOKEN_HEADER] = token;
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers }, (res) => {
      let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.on('error', reject); req.end(payload);
  });
}

test('bridge register/handle: token gating, list, call, validation, release', async () => {
  const { server, url } = await startHub();
  const dir = tmp(); const calls = [];
  try {
    const reg = bridge.register('maestro', sampleTools(calls), { url, dir });
    assert.strictEqual(fs.statSync(reg.file).mode & 0o777, 0o600);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(reg.file, 'utf8')), { url: url + bridge.ROUTE, token: reg.token });

    assert.strictEqual((await post(url, { method: 'list' })).status, 401);
    assert.strictEqual((await post(url, { method: 'list' }, 'f'.repeat(64))).status, 401);

    const list = await post(url, { method: 'list' }, reg.token);
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(list.body.tools.map(t => t.name), ['echo', 'boom']);
    assert.strictEqual(list.body.tools[0].inputSchema.properties.text.type, 'string');
    assert.ok(!('$schema' in list.body.tools[0].inputSchema));

    const ok = await post(url, { method: 'call', name: 'echo', arguments: { text: 'hi' } }, reg.token);
    assert.strictEqual(ok.body.content[0].text, 'echo:hi');
    assert.deepStrictEqual(calls, [{ text: 'hi' }]);
    const bad = await post(url, { method: 'call', name: 'echo', arguments: { text: 5 } }, reg.token);
    assert.strictEqual(bad.body.isError, true); assert.match(bad.body.content[0].text, /Invalid arguments/);
    const thrown = await post(url, { method: 'call', name: 'boom', arguments: {} }, reg.token);
    assert.strictEqual(thrown.body.isError, true); assert.match(thrown.body.content[0].text, /kaput/);
    const unknown = await post(url, { method: 'call', name: 'wallet_send', arguments: {} }, reg.token);
    assert.match(unknown.body.content[0].text, /Unknown tool/);

    reg.release();
    assert.strictEqual(fs.existsSync(reg.file), false);
    assert.strictEqual((await post(url, { method: 'list' }, reg.token)).status, 401);
  } finally { server.close(); }
});

test('mcp-bridge.js speaks stdio MCP and proxies to the hub', async () => {
  const { server, url } = await startHub();
  const calls = [];
  const reg = bridge.register('maestro', sampleTools(calls), { url, dir: tmp() });
  const child = spawn(process.execPath, [codex.MCP_BRIDGE_SCRIPT], { env: { HUB_CODEX_BRIDGE_FILE: reg.file }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let buf = '';
  child.stdout.on('data', (c) => {
    buf += c; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pending.get(m.id)?.(m); }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.strictEqual(init.result.serverInfo.name, 'agent-hub');
    assert.strictEqual(init.result.protocolVersion, '2025-06-18');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await rpc('tools/list', {});
    assert.deepStrictEqual(list.result.tools.map(t => t.name), ['echo', 'boom']);
    const call = await rpc('tools/call', { name: 'echo', arguments: { text: 'yo' } });
    assert.strictEqual(call.result.content[0].text, 'echo:yo');
    const nope = await rpc('nope', {});
    assert.strictEqual(nope.error.code, -32601);
    reg.release();
    const after = await rpc('tools/call', { name: 'echo', arguments: { text: 'late' } });
    assert.strictEqual(after.result.isError, true);
    assert.deepStrictEqual(calls, [{ text: 'yo' }]);
  } finally { child.stdin.end(); child.kill(); server.close(); }
});

// ── gateway guard ────────────────────────────────────────────────────────

test('gateway refuses codex-cli models but still answers supportsImages', () => {
  const gw = require('../lib/gateway-client');
  assert.strictEqual(gw.supportsImages('codex-cli/gpt-5.5'), true);
  assert.strictEqual(gw.resolveProvider('codex-cli/gpt-5.5').provider, 'codex-cli');
  assert.throws(() => gw.transportFor('codex-cli/gpt-5.5'), /only through the Codex CLI/);
});
