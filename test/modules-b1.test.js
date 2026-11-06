'use strict';
// Module manifest fields (server.background, notify, media, receiver), the guard's hub-request rules, the notice agent in lib/modules/index.js, and the setup page.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const manifestLib = require('../lib/modules/manifest');
const { createModules } = require('../lib/modules');
const { HUB_HOME } = require('../lib/hub-home');

const FIX = path.join(__dirname, 'fixtures', 'modules', 'guarddemo');
const base = () => JSON.parse(fs.readFileSync(path.join(FIX, 'module.json'), 'utf8'));
const probs = (m) => manifestLib.validateManifest(m, 'guarddemo').problems.join(' | ');

test('manifest: the new optional fields are accepted when good', () => {
  assert.deepStrictEqual(manifestLib.validateManifest(base(), 'guarddemo').problems, []);
  const m = { ...base(), server: { ...base().server, background: true }, notify: true, media: false, receiver: { paths: ['hook', 'a_b-1'], headers: ['x-sig', 'content-type'], maxBody: 65536 } };
  assert.strictEqual(probs(m), '');
  assert.strictEqual(probs({ ...base(), receiver: { paths: ['hook'], headers: [] } }), '');
});

test('manifest: each bad value of the new fields is reported', () => {
  const b = base();
  assert.match(probs({ ...b, server: { ...b.server, background: 'yes' } }), /server\.background must be true or false/);
  assert.match(probs({ ...b, notify: 1 }), /notify must be true or false/);
  assert.match(probs({ ...b, media: 'x' }), /media must be true or false/);
  assert.match(probs({ ...b, receiver: 'x' }), /receiver must be an object/);
  const paths = (p) => probs({ ...b, receiver: { paths: p } });
  for (const bad of [undefined, [], 'hook', ['Hook'], ['-a'], ['a b'], ['hook', 'hook'], ['a'.repeat(42)], [1], Array.from({ length: 9 }, (_, i) => `p${i}`)]) {
    assert.match(paths(bad), /receiver\.paths must be 1 to 8 short lowercase names/, JSON.stringify(bad));
  }
  const heads = (h) => probs({ ...b, receiver: { paths: ['hook'], headers: h } });
  for (const bad of ['x', ['X-Sig'], ['cookie'], ['set-cookie'], ['authorization'], ['proxy-authorization'], ['host'], ['a', 'a'], ['a b'], Array.from({ length: 9 }, (_, i) => `h${i}`)]) {
    assert.match(heads(bad), /receiver\.headers/, JSON.stringify(bad));
  }
  for (const bad of [0, 1023, 4194305, 1.5, '2048']) assert.match(probs({ ...b, receiver: { paths: ['hook'], maxBody: bad } }), /receiver\.maxBody/, String(bad));
  assert.strictEqual(probs({ ...b, receiver: { paths: ['hook'], maxBody: 1024 } }), '');
  assert.strictEqual(probs({ ...b, receiver: { paths: ['hook'], maxBody: 4194304 } }), '');
});

// ── the guard, run as a real child against the guarddemo fixture ──
function guardRoot(manifestExtra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-b1-'));
  const root = path.join(dir, 'root'); fs.mkdirSync(path.join(root, 'guarddemo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'guarddemo', 'module.json'), JSON.stringify({ ...base(), ...manifestExtra }));
  fs.writeFileSync(path.join(root, 'guarddemo', 'setup.json'), JSON.stringify({ steps: [{ id: 'done', type: 'finish', title: 'Finish' }] }));
  fs.copyFileSync(path.join(FIX, 'server.js'), path.join(root, 'guarddemo', 'server.js'));
  return { dir, root };
}
async function withGuard(manifestExtra, fn) {
  const { dir, root } = guardRoot(manifestExtra);
  const g = spawn(process.execPath, [path.join(__dirname, '..', 'lib', 'modules', 'mcp-guard.js'), 'guarddemo', '--root', root, '--data', path.join(dir, 'modules'), '--state', path.join(dir, 'modules.json'), '--connectors', path.join(dir, 'connectors.json')], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH } });
  try {
    const out = []; let buf = '';
    g.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    const send = (m) => g.stdin.write(JSON.stringify(m) + '\n');
    const until = async (f) => { for (let i = 0; i < 100; i++) { if (f()) return true; await new Promise(res => setTimeout(res, 50)); } return false; };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    await until(() => out.some(m => m.id === 1));
    await fn({ out, send, until });
  } finally { g.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('guard: hub/receive is refused without a receiver in the manifest', async () => {
  await withGuard({}, async ({ out, send, until }) => {
    send({ jsonrpc: '2.0', id: 'r1', method: 'hub/receive', params: { path: 'hook' } });
    assert.ok(await until(() => out.some(m => m.id === 'r1')));
    assert.deepStrictEqual(out.find(m => m.id === 'r1').error, { code: -32601, message: 'hub/receive is not passed through' });
  });
});

test('guard: hub/receive reaches the module when the manifest has a receiver', async () => {
  await withGuard({ receiver: { paths: ['hook'] } }, async ({ out, send, until }) => {
    send({ jsonrpc: '2.0', id: 'r1', method: 'hub/receive', params: { path: 'hook' } });
    assert.ok(await until(() => out.some(m => m.id === 'r1')));
    assert.deepStrictEqual(out.find(m => m.id === 'r1').result, { status: 200, body: 'ok' });
  });
});

test('guard: hub/notify is passed up only with notify:true; hub/other never', async () => {
  for (const notify of [true, undefined, false]) {
    await withGuard(notify === undefined ? {} : { notify }, async ({ out, send, until }) => {
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ping', arguments: {} } });
      assert.ok(await until(() => out.some(m => m.id === 2)), `finished (notify ${notify})`);
      const got = JSON.parse(out.find(m => m.id === 2).result.content[0].text);
      assert.strictEqual(out.some(m => m.id === 'hub-1'), notify === true, `hub/notify passed up: ${notify}`);
      if (notify === true) {
        assert.deepStrictEqual(out.find(m => m.id === 'hub-1'), { jsonrpc: '2.0', id: 'hub-1', method: 'hub/notify', params: { text: 'hi' } });
        send({ jsonrpc: '2.0', id: 'hub-1', result: { ok: true } });
      } else assert.strictEqual(got['hub-1'].code, -32601);
      assert.ok(!out.some(m => m.id === 'hub-2'), 'hub/other is never passed up');
      assert.deepStrictEqual(got['hub-2'], { code: -32601, message: 'Method not found.' });
    });
  }
});

test('guard: hub/refresh_token is passed up only for a module whose manifest rotates its refresh token', async () => {
  const oauth = { flow: 'code', authorizeUrl: 'https://auth.example.com/a', tokenUrl: 'https://auth.example.com/t', rotatesRefreshToken: true, scopes: ['x'], clientIdSecret: 'GD_ID', clientSecretSecret: 'GD_SECRET', refreshTokenSecret: 'GD_TOKEN' };
  const secrets = [{ name: 'GD_ID', label: 'Id' }, { name: 'GD_SECRET', label: 'Secret' }, { name: 'GD_TOKEN', label: 'Token', optional: true }];
  const src = fs.readFileSync(path.join(FIX, 'server.js'), 'utf8').replace(/'hub-1', method: 'hub\/notify', params: \{ text: 'hi' \}/, "'hub-1', method: 'hub/refresh_token', params: { value: 'abcdefghijklmnop' }");
  for (const rotates of [true, false]) {
    const { dir, root } = guardRoot({ secrets, oauth: { ...oauth, rotatesRefreshToken: rotates } });
    fs.writeFileSync(path.join(root, 'guarddemo', 'server.js'), src);
    const g = spawn(process.execPath, [path.join(__dirname, '..', 'lib', 'modules', 'mcp-guard.js'), 'guarddemo', '--root', root, '--data', path.join(dir, 'modules'), '--state', path.join(dir, 'modules.json'), '--connectors', path.join(dir, 'connectors.json')], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH } });
    try {
      const out = []; let buf = '';
      g.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
      g.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ping', arguments: {} } }) + '\n');
      for (let i = 0; i < 100 && !out.some(m => m.id === 2); i++) await new Promise(res => setTimeout(res, 50));
      assert.ok(out.some(m => m.id === 2), `finished (rotates ${rotates})`);
      assert.strictEqual(out.some(m => m.id === 'hub-1' && m.method === 'hub/refresh_token'), rotates);
    } finally { g.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

// ── index.js: notice agent ──
function rig({ agents = [{ name: 'boss' }, { name: 'helper' }, { name: 'kidbot', owner: 'u_member' }, { name: 'tmp' }] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-b1-'));
  const root = path.join(dir, 'root');
  fs.mkdirSync(path.join(root, 'guarddemo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'guarddemo', 'module.json'), JSON.stringify({ ...base(), notify: true, media: true }));
  fs.writeFileSync(path.join(root, 'guarddemo', 'setup.json'), JSON.stringify({ steps: [{ id: 'install', type: 'install', title: 'Install' }, { id: 'agents', type: 'grant', title: 'Agents' }, { id: 'done', type: 'finish', title: 'Finish' }] }));
  fs.copyFileSync(path.join(FIX, 'server.js'), path.join(root, 'guarddemo', 'server.js'));
  const conns = new Map(); const stopped = [];
  const connectors = {
    list: () => ({ connectors: [...conns.values()].map(c => ({ ...c, secretNames: [] })) }),
    upsert: (spec) => { const c = { agents: [], ...(conns.get(spec.id) || {}), ...spec }; conns.set(spec.id, c); return c; },
    stop: (id) => stopped.push(id), remove: (id) => conns.delete(id), readSecrets: () => ({}),
  };
  const mods = createModules({
    root, dataDir: path.join(dir, 'modules'), stateFile: path.join(dir, 'modules.json'), connectorsFile: path.join(dir, 'connectors.json'), connectors,
    isMemberOwned: (a) => a.owner === 'u_member', isVirtual: (n) => n === 'tmp',
    listAgents: () => agents, publish: () => {}, log: () => {},
  });
  return { dir, mods, conns, stopped, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
test('notice agent: refused unless installed and declared, lead or granted, not member-owned or temporary', async () => {
  const r = rig();
  try {
    assert.strictEqual(r.mods.manifestOf('guarddemo'), null, 'not installed yet');
    assert.strictEqual(r.mods.setNoticeAgent('guarddemo', 'helper').ok, false);
    await r.mods.runStep('guarddemo', 'install', {});
    assert.strictEqual(r.mods.manifestOf('guarddemo').id, 'guarddemo');
    const noGrant = r.mods.setNoticeAgent('guarddemo', 'helper');
    assert.strictEqual(noGrant.ok, false); assert.match(noGrant.error, /helper/);
    assert.strictEqual(r.mods.setNoticeAgent('guarddemo', 'kidbot').ok, false);
    assert.strictEqual(r.mods.setNoticeAgent('guarddemo', 'nobody').ok, false);
    assert.strictEqual(r.mods.setNoticeAgent('nomod', 'helper').ok, false);
  } finally { r.cleanup(); }
});

test('notice agent: stored, followed by mediaDir, clearing on ungrant (needs real leads: uses lib/agents ownerLeadNames)', async () => {
  const agentsLib = require('../lib/agents');
  const orig = agentsLib.ownerLeadNames;
  agentsLib.ownerLeadNames = () => ['boss'];
  const r = rig();
  try {
    await r.mods.runStep('guarddemo', 'install', {});
    assert.strictEqual(r.mods.noticeAgentOf('guarddemo'), 'boss', 'the first lead by default');
    assert.strictEqual(r.mods.mediaDirFor('guarddemo'), path.join(HUB_HOME, 'share', 'boss', 'guarddemo'));
    assert.strictEqual(r.conns.get('guarddemo').mediaDir, path.join(HUB_HOME, 'share', 'boss', 'guarddemo'));
    assert.strictEqual(r.conns.get('guarddemo').notify, true);
    assert.strictEqual(r.conns.get('guarddemo').background, false);
    r.mods.setAgents('guarddemo', ['helper'], { by: 'test' });
    const before = r.stopped.length;
    assert.deepStrictEqual(r.mods.setNoticeAgent('guarddemo', 'helper', { by: 'test' }), { ok: true, noticeAgent: 'helper' });
    assert.strictEqual(r.stopped.length, before + 1, 'the running connector is stopped');
    assert.strictEqual(r.mods.noticeAgentOf('guarddemo'), 'helper');
    assert.strictEqual(r.mods.detail('guarddemo').noticeAgent, 'helper');
    assert.strictEqual(r.mods.detail('guarddemo').notify, true);
    assert.strictEqual(r.conns.get('guarddemo').mediaDir, path.join(HUB_HOME, 'share', 'helper', 'guarddemo'));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(r.dir, 'modules.json'), 'utf8')).modules.guarddemo.noticeAgent, 'helper');
    assert.notStrictEqual(r.mods.setNoticeAgent('guarddemo', 'tmp').ok, true);
    // ungranted: the lead takes over and the stored name is deleted
    r.mods.setAgents('guarddemo', [], { by: 'test' });
    assert.strictEqual(r.mods.noticeAgentOf('guarddemo'), 'boss');
    assert.ok(!('noticeAgent' in JSON.parse(fs.readFileSync(path.join(r.dir, 'modules.json'), 'utf8')).modules.guarddemo));
    assert.strictEqual(r.conns.get('guarddemo').mediaDir, path.join(HUB_HOME, 'share', 'boss', 'guarddemo'));
  } finally { agentsLib.ownerLeadNames = orig; r.cleanup(); }
});

test('mediaDirFor: no agent gives null; names are sanitised like a plain agent Files folder', async () => {
  const agentsLib = require('../lib/agents');
  const orig = agentsLib.ownerLeadNames;
  agentsLib.ownerLeadNames = () => [];
  const r = rig();
  try {
    await r.mods.runStep('guarddemo', 'install', {});
    assert.strictEqual(r.mods.noticeAgentOf('guarddemo'), null);
    assert.strictEqual(r.mods.mediaDirFor('guarddemo'), null);
    agentsLib.ownerLeadNames = () => ['My Boss/x'];
    assert.strictEqual(r.mods.mediaDirFor('guarddemo'), path.join(HUB_HOME, 'share', 'My_Boss_x', 'guarddemo'));
  } finally { agentsLib.ownerLeadNames = orig; r.cleanup(); }
});

// ── the setup page ──
test('modules.html: the grant step has the notice select and posts to the notice-agent route', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'modules.html'), 'utf8');
  assert.match(html, /Send its notices to:/);
  assert.match(html, /<select id="notice-agent">/);
  assert.match(html, /m\.notify/);
  assert.match(html, /api\('POST', `\/api\/modules\/\$\{current\.id\}\/notice-agent`, \{ agent \}\)/);
  assert.match(html, /catch \(e\) \{ setMsg\('err', e\.message\); \}/);
});
