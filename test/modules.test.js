'use strict';
// Hub modules (lib/modules): manifests, the guided setup, the connector glue and the per-call guard. Runs the real
// connectors store and the real guard process against test/fixtures/modules/fakebank (a script tool server).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConnectors } = require('../lib/connectors');
const McpStdioClient = require('../lib/skills/mcp-stdio');
const { createModules } = require('../lib/modules');
const manifestLib = require('../lib/modules/manifest');

const FIX_ROOT = path.join(__dirname, 'fixtures', 'modules');

function rig({ wallet = ['trader'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-'));
  const cx = createConnectors({ file: path.join(dir, 'connectors.json'), keyFile: path.join(dir, '.auth-key'), McpClient: McpStdioClient, log: () => {}, unlockTtlMs: 0, baseEnv: { PATH: process.env.PATH, HOME: '/tmp/should-not-be-used', ANTHROPIC_API_KEY: 'sk-LEAK' } });
  const events = [];
  const mods = createModules({
    root: FIX_ROOT, dataDir: path.join(dir, 'modules'), stateFile: path.join(dir, 'modules.json'), connectorsFile: path.join(dir, 'connectors.json'), connectors: cx,
    isWalletAgent: (n) => wallet.includes(n), isMemberOwned: (a) => a.owner === 'u_member',
    listAgents: () => [{ name: 'trader' }, { name: 'doc' }, { name: 'kidbot', owner: 'u_member' }],
    publish: (t, d) => events.push({ t, d }), log: () => {},
  });
  return { dir, cx, mods, events, cleanup: () => { cx.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

async function setupAll(mods, { token = 'tok-123', agents = ['trader'] } = {}) {
  await mods.runStep('fakebank', 'intro', {});
  await mods.runStep('fakebank', 'outside', { confirmed: true });
  await mods.runStep('fakebank', 'install', {});
  await mods.runStep('fakebank', 'key', { values: { FAKEBANK_TOKEN: token } });
  await mods.runStep('fakebank', 'verify', {});
  await mods.runStep('fakebank', 'limits', { values: { tradingEnabled: true, maxUsd: 10, pairs: 'BTC-USD, ETH-USD' } });
  await mods.runStep('fakebank', 'agents', { agents });
  return mods.runStep('fakebank', 'done', {});
}

test('every module shipped in modules/ (none yet) and the test fixture are valid', () => {
  const found = [...manifestLib.discover(path.join(__dirname, '..', 'modules')), ...manifestLib.discover(FIX_ROOT)];
  assert.ok(found.length >= 1, 'at least the fixture');
  for (const m of found) assert.deepStrictEqual(m.problems, [], `${m.id}: ${m.problems.join('; ')}`);
});

test('manifest validation catches the unsafe and the incomplete', () => {
  const base = JSON.parse(fs.readFileSync(path.join(FIX_ROOT, 'fakebank', 'module.json'), 'utf8'));
  const probs = (m) => manifestLib.validateManifest(m, 'fakebank').problems.join(' | ');
  assert.match(probs({ ...base, server: { type: 'mcp-stdio', npm: { package: 'x', version: '^1.0.0', bin: 'x' } } }), /exact version/);
  assert.match(probs({ ...base, risk: 'read' }), /money tools must declare risk "money"/);
  assert.match(probs({ ...base, server: { type: 'mcp-stdio', script: '../../evil.js' } }), /inside the module folder/);
  assert.match(probs({ ...base, settings: [{ key: 'x', type: 'number', label: 'X' }] }), /default is required/);
  assert.match(probs({ ...base, tools: { a: 'maybe' } }), /class must be one of/);
  assert.match(probs({ ...base, id: 'other' }), /must match the folder name/);
  const v = manifestLib.validateManifest(base, 'fakebank');
  const setupProbs = manifestLib.validateSetup({ steps: [{ id: 'a', type: 'secrets', title: 'A', fields: ['NOPE'] }, { id: 'b', type: 'check', check: 'missing', title: 'B' }, { id: 'c', type: 'outside', title: 'C', links: [{ url: 'http://x' }] }] }, v, {}).join(' | ');
  assert.match(setupProbs, /unknown secret NOPE/);
  assert.match(setupProbs, /check "missing" is not exported/);
  assert.match(setupProbs, /links must be https/);
  assert.match(setupProbs, /last step must be "finish"/);
});

test('guided setup end to end: steps in order, key into the vault, check through the guard, grant, switch on', async (t) => {
  const r = rig(); t.after(r.cleanup);
  assert.strictEqual(r.mods.list().find(x => x.id === 'fakebank').state, 'available');
  await assert.rejects(r.mods.runStep('fakebank', 'outside', { confirmed: false }), /Tick "Done it"/);
  await assert.rejects(r.mods.runStep('fakebank', 'key', { values: { FAKEBANK_TOKEN: 'x' } }), /Install step first/);
  await assert.rejects(r.mods.runStep('fakebank', 'done', {}), /Not finished yet/);
  const fin = await setupAll(r.mods);
  assert.strictEqual(fin.module.state, 'ready');
  assert.deepStrictEqual(fin.module.agents, ['trader']);
  assert.ok(fin.module.lastCheck.ok);
  assert.match(fin.module.lastCheck.lines.join(), /fakebank[\/\\]home/, 'the module data home was passed to the server');
  const conn = r.cx.list().connectors.find(c => c.id === 'fakebank');
  assert.strictEqual(conn.module, 'fakebank');
  assert.deepStrictEqual(conn.secretNames, ['FAKEBANK_TOKEN']);
  assert.strictEqual(conn.enabled, true);
  const raw = fs.readFileSync(path.join(r.dir, 'connectors.json'), 'utf8');
  assert.ok(!raw.includes('tok-123'), 'the token is encrypted at rest');
  assert.ok(!fs.readFileSync(path.join(r.dir, 'modules.json'), 'utf8').includes('tok-123'));
  assert.ok(r.events.some(e => e.t === 'modules_changed'));
});

test('a key file is mapped to secrets; an acknowledgement is required when the check asks for one', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.mods.runStep('fakebank', 'install', {});
  await r.mods.runStep('fakebank', 'key', { keyFile: JSON.stringify({ secret: 'risky' }) });
  await assert.rejects(r.mods.runStep('fakebank', 'verify', {}), (e) => e.needsAck === true && /risky/.test(e.message));
  const ok = await r.mods.runStep('fakebank', 'verify', { acknowledged: true });
  assert.ok(ok.result.check.ok);
  await assert.rejects(r.mods.runStep('fakebank', 'key', { keyFile: '{not json' }), /not valid JSON/);
});

test('money modules: only wallet agents, never member agents; ineligible agents are listed with the reason', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.mods.runStep('fakebank', 'install', {});
  const cand = r.mods.detail('fakebank').candidates;
  assert.deepStrictEqual(cand.map(c => [c.name, c.eligible]), [['trader', true], ['doc', false]], 'member-owned agents are not even listed');
  assert.match(cand[1].why, /not a wallet agent/);
  await assert.rejects(r.mods.runStep('fakebank', 'agents', { agents: ['doc'] }), /cannot use Fake Bank: not a wallet agent/);
  await assert.rejects(r.mods.runStep('fakebank', 'agents', { agents: ['kidbot'] }), /owned by a member/);
});

test('the guard: hidden tools stay hidden, limits apply per call with live settings, usage and audit are kept, args can be tightened', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await setupAll(r.mods);
  const specs = await r.cx.toolSpecsFor('trader');
  const names = specs.map(s => s.tool).sort();
  assert.deepStrictEqual(names, ['get_price', 'place_order', 'whoami'], 'off and unlisted (brand_new_tool) tools are not shown');
  assert.strictEqual(specs.find(s => s.tool === 'place_order').cls, 'money');
  assert.strictEqual(r.cx.classifyToolCall({ tool: 'fakebank__place_order', input: {} }).cls, 'money');
  assert.deepStrictEqual(await r.cx.toolSpecsFor('doc'), [], 'not granted');
  const order = (a) => specs.find(s => s.tool === 'place_order').handler(a);
  assert.match(await order({ pair: 'BTC-USD', usd: 8 }), /"tagged":"by-guard"/, 'allowed, and the guard tightened the args');
  assert.match(await order({ pair: 'DOGE-USD', usd: 1 }), /Refused by this hub's limits for Fake Bank: DOGE-USD not allowed/);
  assert.match(await order({ pair: 'BTC-USD', usd: 50 }), /over \$10/);
  assert.match(await order({ pair: 'ETH-USD', usd: 9 }), /daily cap 15/, 'usage from the first order counts');
  r.mods.saveSettings('fakebank', { tradingEnabled: false });
  assert.match(await order({ pair: 'BTC-USD', usd: 1 }), /trading is off/, 'a settings change applies on the next call');
  assert.match(await r.cx.callTool('fakebank', 'delete_everything', {}), /is not enabled in this hub/);
  const audit = r.mods.auditTail('fakebank');
  assert.ok(audit.some(e => e.decision === 'done' && e.record && e.record.usd === 8));
  assert.ok(audit.some(e => e.decision === 'refused' && /daily cap/.test(e.reason)));
  assert.ok(audit.some(e => e.decision === 'hidden' && e.tool === 'delete_everything'));
  const env = JSON.parse(await specs.find(s => s.tool === 'whoami').handler({}));
  assert.strictEqual(env.mode, 'test', 'manifest env reaches the server');
  assert.ok(env.homeEnv.startsWith(r.dir), 'HOME is the module data home, not the hub user home');
});

test('switch off, status, checklist items and remove', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await r.mods.runStep('fakebank', 'install', {});
  assert.strictEqual(r.mods.list().find(x => x.id === 'fakebank').state, 'setup');
  assert.match(r.mods.readinessItems().find(x => x.id === 'module-fakebank').title, /Fake Bank: setup not finished/);
  await assert.rejects(Promise.resolve().then(() => r.mods.setEnabled('fakebank', true)), /Finish the setup first/);
  await setupAll(r.mods);
  assert.deepStrictEqual(r.mods.readinessItems(), []);
  await r.cx.callTool('fakebank', 'place_order', { pair: 'BTC-USD', usd: 1 });   // something for the activity log
  r.mods.setEnabled('fakebank', false);
  assert.strictEqual(r.mods.list().find(x => x.id === 'fakebank').state, 'off');
  assert.deepStrictEqual(await r.cx.toolSpecsFor('trader'), []);
  r.mods.remove('fakebank');
  assert.ok(!r.cx.list().connectors.some(c => c.id === 'fakebank'));
  assert.strictEqual(r.mods.list().find(x => x.id === 'fakebank').state, 'available');
  assert.ok(fs.existsSync(path.join(r.dir, 'modules', 'fakebank', 'audit.jsonl')), 'the activity log is kept');
});

test('a hand-made connector with the module id is never taken over', async (t) => {
  const r = rig(); t.after(r.cleanup);
  r.cx.upsert({ id: 'fakebank', kind: 'mcp', command: 'x' });
  await assert.rejects(r.mods.runStep('fakebank', 'install', {}), /already exists and is not this module's/);
});

test('installer: exact version into the module data folder, scripts off; Node version gate', async () => {
  const installer = require('../lib/modules/installer');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-'));
  const calls = [];
  const runNpm = async (args, cwd) => {
    calls.push({ args, cwd });
    const root = path.join(cwd, 'node_modules', '@x', 'tool');
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@x/tool', version: '1.2.3', bin: { tool: 'bin/t.js' } }));
    fs.writeFileSync(path.join(root, 'bin', 't.js'), '');
    return 'added 1 package';
  };
  const r = await installer.install({ dataDir: dir, id: 'm', npm: { package: '@x/tool', version: '1.2.3', bin: 'tool' }, runNpm });
  assert.ok(r.bin.endsWith(path.join('bin', 't.js')));
  assert.deepStrictEqual(calls[0].args, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', '@x/tool@1.2.3']);
  assert.strictEqual(calls[0].cwd, path.join(dir, 'm', 'pkg'));
  assert.strictEqual(installer.binPath(dir, 'm', { package: '@x/tool', version: '9.9.9', bin: 'tool' }), null, 'another version is not "installed"');
  await assert.rejects(installer.install({ dataDir: dir, id: 'n', npm: { package: '@x/tool', version: '1.2.3', bin: 'tool' }, requires: { node: '>=99' }, runNpm }), /needs Node >=99/);
  assert.strictEqual(installer.nodeSatisfies('>=22', '22.1.0'), true);
  assert.strictEqual(installer.nodeSatisfies('>=22.5', '22.1.0'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('module connectors cannot be changed or removed from the Connectors side; only the module can', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await setupAll(r.mods);
  for (const spec of [{ command: '/bin/sh' }, { args: ['x'] }, { agents: null }, { tools: { place_order: { cls: 'read' } } }, { enabled: false }, { secrets: { FAKEBANK_TOKEN: 'x' } }]) {
    assert.throws(() => r.cx.upsert({ id: 'fakebank', ...spec }), /belongs to the Fake Bank module; change it on the Modules page/, JSON.stringify(spec));
  }
  assert.throws(() => r.cx.setGrants('fakebank', null), /belongs to the Fake Bank module/);
  assert.throws(() => r.cx.remove('fakebank'), /remove it on the Modules page/);
  assert.throws(() => r.cx.upsert({ id: 'sneaky', module: 'fakebank', command: 'x' }), /Only a module can create a module connector/);
  r.cx.upsert({ id: 'fakebank', label: 'Renamed' });    // harmless fields stay editable
});

test('guard protocol hardening: batches, reserved ids, notifications and unknown tools/ methods are not passed through; a failed money call gives its reservation back; one server per connector', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await setupAll(r.mods);
  const specs = await r.cx.toolSpecsFor('trader');
  const order = (a) => specs.find(s => s.tool === 'place_order').handler(a);
  assert.match(await order({ pair: 'BTC-USD', usd: 9, fail: true }), /exchange rejected the order/);
  assert.match(await order({ pair: 'BTC-USD', usd: 9 }), /placed/, 'the failed order did not use up the daily cap');
  const usage = JSON.parse(fs.readFileSync(path.join(r.dir, 'modules', 'fakebank', 'usage.json'), 'utf8'));
  assert.strictEqual(usage.totals.usd, 9);
  // parallel first calls share one server
  r.cx.stop('fakebank');
  const pids = await Promise.all([order({ pair: 'BTC-USD', usd: 1 }), order({ pair: 'BTC-USD', usd: 1 })]);
  assert.strictEqual(new Set(pids.map(x => JSON.parse(x).pid)).size, 1);
  // raw protocol against the guard process
  const { spawn } = require('child_process');
  const g = spawn(process.execPath, [path.join(__dirname, '..', 'lib', 'modules', 'mcp-guard.js'), 'fakebank', '--root', FIX_ROOT, '--data', path.join(r.dir, 'modules'), '--state', path.join(r.dir, 'modules.json'), '--connectors', path.join(r.dir, 'connectors.json')], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH, FAKEBANK_TOKEN: 'secret-token-1' } });
  const out = []; let buf = '';
  g.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => g.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  send([{ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } }]);
  send({ jsonrpc: '2.0', id: 'guard-1', method: 'tools/call', params: { name: 'get_price', arguments: {} } });
  send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'place_order', arguments: { pair: 'BTC-USD', usd: 1 } } });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/secret_backdoor', params: {} });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
  const until = async (fn) => { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(res => setTimeout(res, 50)); } };
  await until(() => out.some(m => m.id === 4));
  g.kill();
  assert.ok(out.some(m => m.id === null && /batched requests are not accepted/.test(m.error.message)));
  assert.ok(out.some(m => m.id === 'guard-1' && /reserved request id/.test(m.error.message)));
  assert.ok(out.some(m => m.id === 3 && /not passed through/.test(m.error.message)));
  assert.ok(!out.some(m => m.result && /placed/.test(JSON.stringify(m.result))), 'a tools/call without an id is dropped');
  assert.ok(!fs.readFileSync(path.join(r.dir, 'modules', 'fakebank', 'audit.jsonl'), 'utf8').includes('secret-token-1'), 'secrets never reach the activity log');
});

test('the guard falls back to the safe default when a stored setting is invalid, and refuses money calls while the module is switched off', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await setupAll(r.mods);
  const st = JSON.parse(fs.readFileSync(path.join(r.dir, 'modules.json'), 'utf8'));
  st.modules.fakebank.settings.maxUsd = 'lots';   // hand-edited nonsense
  fs.writeFileSync(path.join(r.dir, 'modules.json'), JSON.stringify(st));
  const specs = await r.cx.toolSpecsFor('trader');
  const order = (a) => specs.find(s => s.tool === 'place_order').handler(a);
  assert.match(await order({ pair: 'BTC-USD', usd: 50 }), /over \$10/, 'the invalid value falls back to the manifest default (10), not to "no limit"');
  assert.match(await order({ pair: 'BTC-USD', usd: 5 }), /placed/);
  r.mods.setEnabled('fakebank', false);
  assert.match(await order({ pair: 'BTC-USD', usd: 1 }), /Fake Bank is switched off in this hub/, 'a handler captured before the switch-off is refused at call time');
});

test('catalog, health and oauth fields: accepted when right, refused with a plain reason when not', () => {
  const base = JSON.parse(fs.readFileSync(path.join(FIX_ROOT, 'fakesignin', 'module.json'), 'utf8'));
  const probs = (m) => manifestLib.validateManifest(m, 'fakesignin').problems.join(' | ');
  assert.strictEqual(probs(base), '');
  const { catalog, health, oauth, ...bare } = base;
  assert.strictEqual(probs(bare), '', 'all the new fields are optional');
  assert.match(probs({ ...base, catalog: { verified: '2026-02-30' } }), /real date/);
  assert.match(probs({ ...base, catalog: { verified: 'yesterday' } }), /real date/);
  assert.match(probs({ ...base, catalog: { verified: '2999-01-01' } }), /in the future/);
  assert.match(probs({ ...base, catalog: { api: 'x'.repeat(41) } }), /at most 40 characters/);
  assert.match(probs({ ...base, catalog: { official: 'yes' } }), /true or false/);
  assert.match(probs({ ...base, health: {} }), /health must be/);
  assert.match(probs({ ...base, oauth: { ...oauth, deviceUrl: 'http://auth.example.com/device' } }), /deviceUrl must be an https/);
  assert.match(probs({ ...base, oauth: { ...oauth, tokenUrl: 'ftp://x' } }), /tokenUrl must be an https/);
  assert.match(probs({ ...base, oauth: { ...oauth, scopes: [] } }), /scopes/);
  assert.match(probs({ ...base, oauth: { ...oauth, clientSecretSecret: 'NOT_DECLARED' } }), /not declared in secrets/);
  const v = manifestLib.validateManifest(bare, 'fakesignin');
  assert.match(manifestLib.validateSetup({ steps: [{ id: 's', type: 'signin', title: 'S' }, { id: 'f', type: 'finish', title: 'F' }] }, v, {}).join(' | '), /needs an oauth block/);
});

test('a health check that index.js does not export breaks the module; hasGuide is detected from guide.md', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-h-'));
  try {
    const copy = path.join(dir, 'fakesignin');
    fs.cpSync(path.join(FIX_ROOT, 'fakesignin'), copy, { recursive: true });
    assert.strictEqual(manifestLib.loadModule(copy).hasGuide, true);
    fs.unlinkSync(path.join(copy, 'guide.md'));
    assert.strictEqual(manifestLib.loadModule(copy).hasGuide, false);
    const j = JSON.parse(fs.readFileSync(path.join(copy, 'module.json'), 'utf8')); j.health.check = 'nope';
    fs.writeFileSync(path.join(copy, 'module.json'), JSON.stringify(j));
    assert.match(manifestLib.loadModule(copy).problems.join(' | '), /health.check "nope" is not exported/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setAgents: refuses member agents, temporary workers and non-wallet agents on a money module; drops leads; stores through the module path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-sa-'));
  const cx = createConnectors({ file: path.join(dir, 'connectors.json'), keyFile: path.join(dir, '.auth-key'), McpClient: McpStdioClient, log: () => {}, unlockTtlMs: 0 });
  const mods = createModules({
    root: FIX_ROOT, dataDir: path.join(dir, 'modules'), stateFile: path.join(dir, 'modules.json'), connectorsFile: path.join(dir, 'connectors.json'), connectors: cx,
    isWalletAgent: (n) => n === 'sam', isMemberOwned: (a) => a.owner === 'u_member', isVirtual: (n) => n === 'temp1',
    listAgents: () => [{ name: 'owner', lead: true }, { name: 'sam' }, { name: 'helper' }, { name: 'kidbot', owner: 'u_member' }, { name: 'temp1' }],
    log: () => {},
  });
  try {
    await mods.runStep('fakebank', 'install', {});
    await mods.runStep('fakesignin', 'install', {});
    const agentsOf = (id) => cx.list().connectors.find(c => c.id === id).agents;
    assert.throws(() => mods.setAgents('fakebank', ['kidbot']), /unknown, or owned by a member/);
    assert.throws(() => mods.setAgents('fakebank', ['temp1']), /temporary worker/);
    assert.throws(() => mods.setAgents('fakebank', ['helper']), /not a wallet agent/);
    assert.throws(() => mods.setAgents('fakebank', ['ghost']), /not an agent/);
    assert.deepStrictEqual(agentsOf('fakebank'), [], 'a refused list stores nothing');
    assert.deepStrictEqual(mods.setAgents('fakebank', ['owner', 'sam', 'sam'], { by: 'owner' }), ['sam'], 'the lead is dropped silently');
    assert.deepStrictEqual(agentsOf('fakebank'), ['sam']);
    assert.deepStrictEqual(mods.setAgents('fakesignin', ['helper', 'sam']), ['helper', 'sam'], 'a non-money module takes any admin-side agent');
    const d = mods.detail('fakesignin');
    assert.deepStrictEqual(d.leads, ['owner']);
    assert.deepStrictEqual(d.catalog, { verified: '2026-01-15', api: 'Fake Mail API v1', official: false });
    assert.strictEqual(d.health, true); assert.strictEqual(d.hasGuide, true); assert.strictEqual(d.lastCheck, null);
    const l = mods.list().find(x => x.id === 'fakebank');
    assert.strictEqual(l.catalog, null); assert.strictEqual(l.health, false); assert.strictEqual(l.hasGuide, false);
  } finally { cx.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('money module: an eligible wallet lead stays in the list and is an ordinary candidate; other modules drop leads; leadsAlways says which', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-ml-'));
  const cx = createConnectors({ file: path.join(dir, 'connectors.json'), keyFile: path.join(dir, '.auth-key'), McpClient: McpStdioClient, log: () => {}, unlockTtlMs: 0 });
  const mods = createModules({
    root: FIX_ROOT, dataDir: path.join(dir, 'modules'), stateFile: path.join(dir, 'modules.json'), connectorsFile: path.join(dir, 'connectors.json'), connectors: cx,
    isWalletAgent: (n) => n === 'sam' || n === 'chief', isMemberOwned: (a) => a.owner === 'u_member',
    listAgents: () => [{ name: 'chief', lead: true }, { name: 'owner', lead: true }, { name: 'sam' }, { name: 'helper' }],
    log: () => {},
  });
  try {
    await mods.runStep('fakebank', 'install', {});
    await mods.runStep('fakesignin', 'install', {});
    const agentsOf = (id) => cx.list().connectors.find(c => c.id === id).agents;
    assert.deepStrictEqual(mods.setAgents('fakebank', ['chief', 'owner', 'sam']), ['chief', 'sam'], 'the wallet lead is kept; the lead that is not a wallet agent is dropped as before');
    assert.deepStrictEqual(agentsOf('fakebank'), ['chief', 'sam']);
    assert.deepStrictEqual(mods.setAgents('fakesignin', ['chief', 'helper']), ['helper'], 'a non-money module drops leads');
    const bank = mods.detail('fakebank'), mail = mods.detail('fakesignin');
    assert.strictEqual(bank.leadsAlways, false); assert.strictEqual(mail.leadsAlways, true);
    assert.deepStrictEqual(bank.candidates.find(c => c.name === 'chief'), { name: 'chief', display: 'chief', eligible: true, why: null });
    assert.strictEqual(bank.candidates.find(c => c.name === 'owner').eligible, false, 'a lead that is not a wallet agent shows why');
    assert.deepStrictEqual(bank.leads, ['chief', 'owner']);
  } finally { cx.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('money is decided by risk or by any tool class, in the source', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'modules', 'index.js'), 'utf8');
  assert.match(src, /const isMoney = \(m\) => !!\(m\.manifest && \(m\.manifest\.risk === 'money' \|\| Object\.values\(m\.manifest\.tools \|\| \{\}\)\.includes\('money'\)\)\);/);
  assert.match(src, /leadsAlways: !isMoney\(m\)/);
});

test('step ids in setup.json: lowercase, digits and dashes, at most 32, starting with a letter', () => {
  const base = JSON.parse(fs.readFileSync(path.join(FIX_ROOT, 'fakebank', 'module.json'), 'utf8'));
  const v = manifestLib.validateManifest(base, 'fakebank');
  const probs = (id) => manifestLib.validateSetup({ steps: [{ id, type: 'explain', title: 'A' }, { id: 'done', type: 'finish', title: 'Done' }] }, v, {}).join(' | ');
  assert.strictEqual(probs('ok-step-2'), '');
  assert.strictEqual(probs('a'), '', 'a single letter is fine');
  for (const bad of ['Upper', '1abc', 'has space', "x'y", 'a_b', '-a', 'a'.repeat(33), '../x']) assert.match(probs(bad), /step id .*lowercase letters, digits and dashes/, bad);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-sid-'));
  try {
    const copy = path.join(dir, 'fakebank'); fs.cpSync(path.join(FIX_ROOT, 'fakebank'), copy, { recursive: true });
    const setup = JSON.parse(fs.readFileSync(path.join(copy, 'setup.json'), 'utf8'));
    setup.steps[0].id = 'Bad Id';
    fs.writeFileSync(path.join(copy, 'setup.json'), JSON.stringify(setup));
    const loaded = manifestLib.loadModule(copy);
    assert.match(loaded.problems.join(' | '), /step id "Bad Id"/, 'the module becomes broken like for any other problem');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── backup modules and the hub tool class (fixtures/modules/fakebackup) ──
async function setupBackup(mods) {
  await mods.runStep('fakebackup', 'install', {});
  return mods.runStep('fakebackup', 'done', {});
}

test('backup: true needs the four hub tools; a wrong class or a missing tool is a plain reason', () => {
  const base = JSON.parse(fs.readFileSync(path.join(FIX_ROOT, 'fakebackup', 'module.json'), 'utf8'));
  const probs = (m) => manifestLib.validateManifest(m, 'fakebackup').problems.join(' | ');
  assert.strictEqual(probs(base), '');
  assert.ok(manifestLib.TOOL_CLASSES.includes('hub'));
  const { backup_get, ...noGet } = base.tools;
  assert.match(probs({ ...base, tools: noGet }), /must declare the tool backup_get/);
  assert.match(probs({ ...base, tools: { ...base.tools, backup_put: 'write' } }), /backup_put: a backup tool must have class "hub"/);
  assert.match(probs({ ...base, backup: 'yes' }), /backup must be true or false/);
  assert.strictEqual(probs({ ...base, backup: false, tools: { peek: 'read' } }), '', 'without backup: true the tools are free');
});

const HUB = { hub: true };
test('hub tools: hidden from agents and tools/list, reachable by the hub through the guard, audited as non-read', async (t) => {
  const r = rig(); t.after(r.cleanup);
  const fin = await setupBackup(r.mods);
  assert.strictEqual(fin.module.backup, true);
  assert.strictEqual(r.mods.list().find(x => x.id === 'fakebackup').backup, true);
  assert.strictEqual(r.mods.list().find(x => x.id === 'fakebank').backup, false);
  const conn = r.cx.list().connectors.find(c => c.id === 'fakebackup');
  assert.deepStrictEqual(Object.keys(conn.tools || {}).sort(), ['peek', 'usage'], 'the connector keeps only agent-visible tools');
  assert.deepStrictEqual((await r.cx.toolSpecsFor('trader')).map(s => s.tool), [], 'not granted yet');
  r.mods.setAgents('fakebackup', ['trader']);
  assert.deepStrictEqual((await r.cx.toolSpecsFor('trader')).map(s => s.tool).sort(), ['peek', 'usage'], 'an agent sees only the read tools');
  const seen = await r.cx.test('fakebackup');
  assert.deepStrictEqual(seen.tools.map(x => x.name).sort(), ['peek', 'usage'], "the guard's tools/list leaves hub tools out");

  const src = path.join(r.dir, 'in.bin'); const out = path.join(r.dir, 'out.bin');
  fs.writeFileSync(src, 'hello backup');
  const put = JSON.parse(await r.cx.callTool('fakebackup', 'backup_put', { file: src, name: 'a.zip' }, HUB));
  assert.deepStrictEqual(put, { name: 'a.zip', size: 12, md5: require('crypto').createHash('md5').update('hello backup').digest('hex') });
  const list = JSON.parse(await r.cx.callTool('fakebackup', 'backup_list', {}, HUB));
  assert.deepStrictEqual(list.files.map(f => [f.name, f.size]), [['a.zip', 12]]);
  assert.ok(!Number.isNaN(Date.parse(list.files[0].created)));
  assert.deepStrictEqual(JSON.parse(await r.cx.callTool('fakebackup', 'backup_get', { name: 'a.zip', out }, HUB)), { size: 12, md5: put.md5 });
  assert.strictEqual(fs.readFileSync(out, 'utf8'), 'hello backup');
  assert.match(await r.cx.callTool('fakebackup', 'backup_delete', { name: 'nope.zip' }, HUB), /No such backup/);
  assert.deepStrictEqual(JSON.parse(await r.cx.callTool('fakebackup', 'backup_delete', { name: 'a.zip' }, HUB)), { deleted: 'a.zip' });
  assert.match(await r.cx.callTool('fakebackup', 'not_listed', {}, HUB), /is not enabled in this hub/, 'an unlisted tool is still refused');

  const audit = r.mods.auditTail('fakebackup');
  for (const tool of ['backup_put', 'backup_list', 'backup_get', 'backup_delete']) {
    assert.ok(audit.some(e => e.tool === tool && e.cls === 'hub' && e.decision === 'allowed'), `${tool} allowed and audited`);
    assert.ok(audit.some(e => e.tool === tool && e.decision === 'done'), `${tool} result audited`);
  }
  assert.ok(!audit.some(e => e.tool === 'peek'), 'read calls are not audited');
});

test('backupModules(): only finished, switched-on backup modules; attention from a failed check still counts', async (t) => {
  const r = rig(); t.after(r.cleanup);
  assert.deepStrictEqual(r.mods.backupModules(), [], 'not installed');
  await r.mods.runStep('fakebackup', 'install', {});
  assert.deepStrictEqual(r.mods.backupModules(), [], 'setup not finished');
  await r.mods.runStep('fakebackup', 'done', {});
  assert.deepStrictEqual(r.mods.backupModules(), [{ id: 'fakebackup', label: 'Fake Vault' }]);
  r.mods.setEnabled('fakebackup', false);
  assert.deepStrictEqual(r.mods.backupModules(), [], 'switched off');
  r.mods.setEnabled('fakebackup', true);
  const s = JSON.parse(fs.readFileSync(path.join(r.dir, 'modules.json'), 'utf8'));
  s.modules.fakebackup.lastCheck = { ok: false, summary: 'down' };
  fs.writeFileSync(path.join(r.dir, 'modules.json'), JSON.stringify(s));
  assert.strictEqual(r.mods.list().find(x => x.id === 'fakebackup').state, 'attention');
  assert.deepStrictEqual(r.mods.backupModules(), [{ id: 'fakebackup', label: 'Fake Vault' }]);
  await setupAll(r.mods);
  assert.ok(!r.mods.backupModules().some(x => x.id === 'fakebank'), 'a module without backup: true is never listed');
  fs.writeFileSync(path.join(r.dir, 'modules.json'), '{broken');
  assert.deepStrictEqual(r.mods.backupModules(), [], 'unreadable state gives an empty list');
});

test('callTool timeoutMs: a slow upload works with a long wait and fails with a short one', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await setupBackup(r.mods);
  const src = path.join(r.dir, 'in.bin'); fs.writeFileSync(src, 'x');
  const put = (delayMs, opts) => r.cx.callTool('fakebackup', 'backup_put', { file: src, name: `t${delayMs}.zip`, delayMs }, { hub: true, ...opts });
  await assert.rejects(put(1500, { timeoutMs: 300 }), /timed out after 300ms/);
  assert.match(await put(600, { timeoutMs: 10000 }), /"name":"t600.zip"/);
  assert.match(await put(0), /"size":1/, 'no option: the default wait');
});

test('hub capability: a hub tool without the flag is refused; with it it works; the server never sees __hub; the audit never holds the secret', async (t) => {
  const r = rig(); t.after(r.cleanup);
  await setupBackup(r.mods);
  const refused = await r.cx.callTool('fakebackup', 'backup_list', {});
  assert.match(refused, /only for the hub's own calls/);
  // a guess at the field does not help: an agent-style call carrying a made-up __hub is refused too
  assert.match(await r.cx.callTool('fakebackup', 'backup_list', { __hub: 'guess' }), /only for the hub's own calls/);
  assert.match(await r.cx.callTool('fakebackup', 'backup_list', { __hub: '' }, { hub: false }), /only for the hub's own calls/);
  const ok = JSON.parse(await r.cx.callTool('fakebackup', 'backup_list', { install: '0123456789abcdef', __hub: 'ignored' }, { hub: true }));
  assert.deepStrictEqual(ok.argKeys, ['install'], 'the module server saw the arguments without __hub');
  assert.strictEqual(ok.hubEnv, false, 'the module server does not get the secret in its environment');
  // a read tool called with a stray __hub is stripped as well
  const peek = JSON.parse(await r.cx.callTool('fakebackup', 'peek', { __hub: 'x' }));
  assert.ok(peek.files >= 0);
  const raw = fs.readFileSync(path.join(r.dir, 'modules', 'fakebackup', 'audit.jsonl'), 'utf8');
  assert.ok(raw.includes('"decision":"refused"') && raw.includes('"decision":"done"'));
  assert.ok(!raw.includes('__hub'), 'the audit never mentions the field');
});

test('minTools: a module with no agent-visible tools answers a hub call without the 7.5 s wait', async (t) => {
  const r = rig(); t.after(r.cleanup);
  // a copy of the fixture whose tools are all hub tools
  const root = path.join(r.dir, 'hubonly-root'); const dir = path.join(root, 'fakebackup');
  fs.cpSync(path.join(FIX_ROOT, 'fakebackup'), dir, { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf8'));
  m.tools = { backup_put: 'hub', backup_list: 'hub', backup_delete: 'hub', backup_get: 'hub' };
  fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify(m));
  const dataDir = path.join(r.dir, 'm2');
  const mods = createModules({ root, dataDir, stateFile: path.join(r.dir, 'm2.json'), connectorsFile: path.join(r.dir, 'connectors.json'), connectors: r.cx,
    isWalletAgent: () => false, isMemberOwned: () => false, listAgents: () => [], publish: () => {}, log: () => {} });
  await mods.runStep('fakebackup', 'install', {});
  await mods.runStep('fakebackup', 'done', {});
  const t0 = Date.now();
  const out = JSON.parse(await r.cx.callTool('fakebackup', 'backup_list', { install: '0123456789abcdef' }, { hub: true }));
  assert.ok(Array.isArray(out.files));
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
});
