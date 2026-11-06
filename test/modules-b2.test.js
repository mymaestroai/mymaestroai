'use strict';
// Camera-module support: rotatingSecret, server.callTimeoutSec, receiver.timeoutSec, MODULE_SETTINGS,
// hub-tool results kept out of the audit log, settings saves restarting the connector, callTimeoutMs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const manifestLib = require('../lib/modules/manifest');
const { createModules } = require('../lib/modules');
const { createConnectors } = require('../lib/connectors');
const { createReceivers } = require('../lib/modules/receivers');

const FIX = path.join(__dirname, 'fixtures', 'modules', 'guarddemo');
const base = () => JSON.parse(fs.readFileSync(path.join(FIX, 'module.json'), 'utf8'));
const probs = (m) => manifestLib.validateManifest(m, 'guarddemo').problems.join(' | ');
const SECRETS = [{ name: 'GD_USER', label: 'User' }, { name: 'GD_TOKEN', label: 'Token', optional: true }];
const HUB_SECRET = 'ab'.repeat(32);
const GUARD = path.join(__dirname, '..', 'lib', 'modules', 'mcp-guard.js');

// ── manifest ──
test('manifest: rotatingSecret, server.callTimeoutSec and receiver.timeoutSec accept good values', () => {
  const b = base();
  assert.strictEqual(probs({ ...b, secrets: SECRETS, rotatingSecret: 'GD_TOKEN' }), '');
  for (const n of [10, 60, 300]) assert.strictEqual(probs({ ...b, server: { ...b.server, callTimeoutSec: n } }), '', String(n));
  for (const n of [5, 10, 30]) assert.strictEqual(probs({ ...b, receiver: { paths: ['hook'], timeoutSec: n } }), '', String(n));
});

test('manifest: bad rotatingSecret, callTimeoutSec and timeoutSec are reported', () => {
  const b = base();
  assert.match(probs({ ...b, secrets: SECRETS, rotatingSecret: 'NOPE' }), /rotatingSecret: "NOPE" is not declared in secrets/);
  assert.match(probs({ ...b, secrets: SECRETS, rotatingSecret: 'GD_USER' }), /rotatingSecret: "GD_USER" must be an optional secret/);
  assert.match(probs({ ...b, rotatingSecret: 'GD_TOKEN' }), /rotatingSecret/);
  assert.match(probs({ ...b, secrets: SECRETS, rotatingSecret: 5 }), /rotatingSecret/);
  for (const bad of [9, 301, 1.5, '60', null]) assert.match(probs({ ...b, server: { ...b.server, callTimeoutSec: bad } }), /server\.callTimeoutSec must be a whole number from 10 to 300/, String(bad));
  for (const bad of [4, 31, 2.5, '10', null]) assert.match(probs({ ...b, receiver: { paths: ['hook'], timeoutSec: bad } }), /receiver\.timeoutSec must be a whole number from 5 to 30/, String(bad));
});

// ── the guard, run as a real child ──
const SERVER = `
let buf = '';
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'x', version: '1' } } });
    else if (m.method === 'tools/list') out({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }] } });
    else if (m.method === 'tools/call') {
      const n = m.params.name;
      if (n === 'ping') out({ jsonrpc: '2.0', id: 'hub-1', method: 'hub/refresh_token', params: { value: 'abcdefghijklmnop' } });
      else if (n === 'show') out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: process.env.MODULE_SETTINGS || '' }] } });
      else out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ONE-TIME-CODE-12345' }] } });
      if (n === 'ping') out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'done' }] } });
    }
  }
});
`;

async function withGuard(extra, fn, state) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-b2-'));
  const root = path.join(dir, 'root'); fs.mkdirSync(path.join(root, 'guarddemo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'guarddemo', 'module.json'), JSON.stringify({ ...base(), tools: { ping: 'read', show: 'read', setup_code: 'hub' }, ...extra }));
  fs.writeFileSync(path.join(root, 'guarddemo', 'setup.json'), JSON.stringify({ steps: [{ id: 'done', type: 'finish', title: 'Finish' }] }));
  fs.writeFileSync(path.join(root, 'guarddemo', 'server.js'), SERVER);
  if (state) fs.writeFileSync(path.join(dir, 'modules.json'), JSON.stringify(state));
  const g = spawn(process.execPath, [GUARD, 'guarddemo', '--root', root, '--data', path.join(dir, 'modules'), '--state', path.join(dir, 'modules.json'), '--connectors', path.join(dir, 'connectors.json')], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH, MYMAESTRO_HUB_SECRET: HUB_SECRET } });
  try {
    const out = []; let buf = '';
    g.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    const send = (m) => g.stdin.write(JSON.stringify(m) + '\n');
    const until = async (f) => { for (let i = 0; i < 100; i++) { if (f()) return true; await new Promise(res => setTimeout(res, 50)); } return false; };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    await until(() => out.some(m => m.id === 1));
    await fn({ out, send, until, dir });
  } finally { g.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('guard: hub/refresh_token is allowed by rotatingSecret and refused without it', async () => {
  for (const withField of [true, false]) {
    await withGuard(withField ? { secrets: SECRETS, rotatingSecret: 'GD_TOKEN' } : { secrets: SECRETS }, async ({ out, send, until }) => {
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ping', arguments: {} } });
      assert.ok(await until(() => out.some(m => m.id === 2)));
      assert.strictEqual(out.some(m => m.id === 'hub-1' && m.method === 'hub/refresh_token'), withField);
    });
  }
});

test('guard: MODULE_SETTINGS carries the current safe settings into the server', async () => {
  const settings = [{ key: 'mode', type: 'string', label: 'Mode', default: 'a' }, { key: 'n', type: 'number', label: 'N', default: 3 }];
  await withGuard({ settings }, async ({ out, send, until }) => {
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'show', arguments: {} } });
    assert.ok(await until(() => out.some(m => m.id === 2)));
    assert.deepStrictEqual(JSON.parse(out.find(m => m.id === 2).result.content[0].text), { mode: 'b', n: 3 });
  }, { modules: { guarddemo: { settings: { mode: 'b' } } } });
});

test('guard: the result of a hub-class tool never reaches audit.jsonl', async () => {
  await withGuard({}, async ({ out, send, until, dir }) => {
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'setup_code', arguments: { __hub: HUB_SECRET } } });
    assert.ok(await until(() => out.some(m => m.id === 2)));
    assert.match(out.find(m => m.id === 2).result.content[0].text, /ONE-TIME-CODE-12345/, 'the hub still gets it');
    await new Promise(r => setTimeout(r, 100));
    const audit = fs.readFileSync(path.join(dir, 'modules', 'guarddemo', 'audit.jsonl'), 'utf8');
    assert.ok(audit.includes('"tool":"setup_code"'), 'the call is audited');
    assert.ok(!audit.includes('ONE-TIME-CODE'), 'the result text is not');
    assert.ok(/"decision":"done"/.test(audit));
  });
});

// ── index.js: settings restart the connector; callTimeoutMs / rotatingSecret reach the upsert ──
function rig(manifestExtra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-b2-'));
  const root = path.join(dir, 'root'); fs.mkdirSync(path.join(root, 'guarddemo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'guarddemo', 'module.json'), JSON.stringify({ ...base(), settings: [{ key: 'n', type: 'number', label: 'N', default: 3 }], ...manifestExtra }));
  fs.writeFileSync(path.join(root, 'guarddemo', 'setup.json'), JSON.stringify({ steps: [{ id: 'install', type: 'install', title: 'Install' }, { id: 'set', type: 'settings', title: 'Settings' }, { id: 'done', type: 'finish', title: 'Finish' }] }));
  fs.copyFileSync(path.join(FIX, 'server.js'), path.join(root, 'guarddemo', 'server.js'));
  const conns = new Map(); const calls = [];
  const connectors = {
    list: () => ({ connectors: [...conns.values()].map(c => ({ ...c, secretNames: [] })) }),
    upsert: (spec) => { const c = { agents: [], ...(conns.get(spec.id) || {}), ...spec }; conns.set(spec.id, c); return c; },
    stop: (id) => calls.push(`stop:${id}`), startBackground: () => { calls.push('startBackground'); return []; },
    remove: (id) => conns.delete(id), readSecrets: () => ({}),
  };
  const mods = createModules({
    root, dataDir: path.join(dir, 'modules'), stateFile: path.join(dir, 'modules.json'), connectorsFile: path.join(dir, 'connectors.json'), connectors,
    listAgents: () => [], publish: () => {}, log: () => {},
  });
  return { dir, mods, conns, calls, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('index: ensureConnector passes rotatingSecret and callTimeoutMs from the manifest', async () => {
  const r = rig({ secrets: SECRETS, rotatingSecret: 'GD_TOKEN', server: { type: 'mcp-stdio', script: 'server.js', callTimeoutSec: 120 } });
  try {
    await r.mods.runStep('guarddemo', 'install', {});
    const c = r.conns.get('guarddemo');
    assert.strictEqual(c.rotatingSecret, 'GD_TOKEN');
    assert.strictEqual(c.callTimeoutMs, 120000);
  } finally { r.cleanup(); }
  const r2 = rig();
  try {
    await r2.mods.runStep('guarddemo', 'install', {});
    assert.strictEqual(r2.conns.get('guarddemo').callTimeoutMs, undefined);
    assert.strictEqual(r2.conns.get('guarddemo').rotatingSecret, null);
  } finally { r2.cleanup(); }
});

test('index: saving settings stops a running connector and restarts a background one that is enabled', async () => {
  const r = rig({ server: { type: 'mcp-stdio', script: 'server.js', background: true } });
  try {
    await r.mods.runStep('guarddemo', 'install', {});
    r.calls.length = 0;
    r.mods.saveSettings('guarddemo', { n: 5 });
    assert.deepStrictEqual(r.calls, ['stop:guarddemo'], 'disabled: only stopped');
    r.conns.get('guarddemo').enabled = true;
    r.calls.length = 0;
    await r.mods.runStep('guarddemo', 'set', { values: { n: 6 } });
    assert.deepStrictEqual(r.calls, ['stop:guarddemo', 'startBackground']);
  } finally { r.cleanup(); }
  const r2 = rig();
  try {
    await r2.mods.runStep('guarddemo', 'install', {});
    r2.conns.get('guarddemo').enabled = true;
    r2.calls.length = 0;
    r2.mods.saveSettings('guarddemo', { n: 7 });
    assert.deepStrictEqual(r2.calls, ['stop:guarddemo'], 'not a background module: no start');
  } finally { r2.cleanup(); }
});

// ── connectors.js: callTimeoutMs ──
test('connectors: callTimeoutMs is module-managed, bounded, and becomes the client timeout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connb2-'));
  const all = [];
  class FakeClient extends EventEmitter {
    constructor(command, args, opts) { super(); this.opts = opts; all.push(this); }
    async connect() {} async listTools() { return [{ name: 'one' }]; } async disconnect() {}
  }
  const cx = createConnectors({ file: path.join(dir, 'connectors.json'), keyFile: path.join(dir, '.auth-key'), McpClient: FakeClient, log: () => {}, unlockTtlMs: 0, baseEnv: { PATH: process.env.PATH }, leadNames: () => ['owner'] });
  try {
    const spec = { kind: 'mcp', command: process.execPath, args: ['x'], module: 'm', enabled: true };
    cx.upsert({ id: 'ca', ...spec, callTimeoutMs: 120000 }, { byModule: true });
    cx.upsert({ id: 'cb', ...spec, callTimeoutMs: 5000 }, { byModule: true });
    cx.upsert({ id: 'cc', ...spec }, { byModule: true });
    const get = (id) => JSON.parse(fs.readFileSync(path.join(dir, 'connectors.json'), 'utf8')).connectors.find(x => x.id === id);
    assert.strictEqual(get('ca').callTimeoutMs, 120000);
    assert.strictEqual(get('cb').callTimeoutMs, null);
    assert.throws(() => cx.upsert({ id: 'ca', callTimeoutMs: 20000 }), /callTimeoutMs/, 'locked against edits outside the module');
    for (const id of ['ca', 'cb', 'cc']) await cx.callTool(id, 'one', {}).catch(() => {});
    const timeouts = all.map(x => x.opts.timeout);
    assert.deepStrictEqual(timeouts.sort((x, y) => x - y), [60000, 60000, 120000]);
  } finally { cx.shutdown && cx.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── receivers.js: timeoutSec ──
test('receivers: the request deadline is receiver.timeoutSec seconds, 10 by default', async () => {
  for (const [timeoutSec, want] of [[undefined, 10000], [25, 25000]]) {
    const seen = [];
    const r = createReceivers({
      manifestOf: () => ({ receiver: { paths: ['events'], ...(timeoutSec ? { timeoutSec } : {}) } }),
      connectorFor: () => ({ id: 'demo', enabled: true }),
      request: async (id, method, params, opts) => { seen.push(opts); return { status: 200, body: 'ok' }; },
      getSetting: () => ({}),
    });
    const req = new EventEmitter();
    req.method = 'POST'; req.url = '/hooks/demo/events'; req.headers = { host: 'hub.example.com' };
    req.socket = { remoteAddress: '203.0.113.9', destroyed: false, destroy() {} };
    const res = { headersSent: false, writeHead() { this.headersSent = true; }, end() { this.ended = true; } };
    const p = r.handle(req, res, { id: 'demo', sub: 'events' });
    req.emit('data', Buffer.from('x')); req.emit('end');
    await p;
    assert.deepStrictEqual(seen, [{ timeoutMs: want }]);
  }
});
