'use strict';
// Hub changes for a "Remote computers" style module: H1 caller identity (__agent), H2 owner approval from a module
// (hub/approve), H3 media: "common", H4 lockfile runtime install (npm ci), H5 backups leave out runtime/ and pkg/.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const manifestLib = require('../lib/modules/manifest');
const installer = require('../lib/modules/installer');
const { createModules } = require('../lib/modules');
const { createConnectors } = require('../lib/connectors');
const { createApprovals } = require('../lib/approvals');
const { HUB_HOME } = require('../lib/hub-home');

const GUARD = path.join(__dirname, '..', 'lib', 'modules', 'mcp-guard.js');
const HUB_SECRET = 'cd'.repeat(32);
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const LOCK = { name: 'x', lockfileVersion: 3, requires: true, packages: { '': { name: 'x', version: '1.0.0', dependencies: { a: '1.0.0' } }, 'node_modules/a': { version: '1.0.0', resolved: 'https://registry.example.com/a/-/a-1.0.0.tgz', integrity: 'sha512-AAAA' } } };
/** A fake `npm ci`: makes node_modules/<dep>/package.json at the locked version for each top-level dependency of the lockfile in cwd. */
function fakeCi(before) {
  return async (args, cwd, opts) => {
    if (before) before(args, cwd, opts);
    const lock = JSON.parse(fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8'));
    for (const n of Object.keys(lock.packages[''].dependencies || {})) {
      const d = path.join(cwd, 'node_modules', n); fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: n, version: lock.packages[`node_modules/${n}`].version }));
      fs.writeFileSync(path.join(d, 'index.js'), 'module.exports = {};');   // a package's entry file: a runtime without it counts as damaged
    }
    return 'added 1 package';
  };
}
const BASE = { id: 'demo', name: 'Demo', category: 'Test', summary: 'A test module.', risk: 'read', server: { type: 'mcp-stdio', script: 'server.js' }, tools: { peek: 'read', echo: 'write' } };
const SETUP = { steps: [{ id: 'install', type: 'install', title: 'Install' }, { id: 'done', type: 'finish', title: 'Finish' }] };
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
    else if (m.method === 'tools/list') out({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'peek', inputSchema: { type: 'object', properties: {} } }, { name: 'echo', inputSchema: { type: 'object', properties: {} } }] } });
    else if (m.method === 'tools/call') {
      if (m.params.arguments && m.params.arguments.ask) out({ jsonrpc: '2.0', id: 'hub-9', method: 'hub/approve', params: { call: m.params.arguments.__call, title: 'ok?' } });
      out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({ args: m.params.arguments, runtime: process.env.MODULE_RUNTIME_DIR || null }) }] } });
    } else if (m.id && m.id.startsWith && m.id.startsWith('hub-')) process.stderr.write('HUBANSWER ' + JSON.stringify(m) + '\\n');
  }
});
`;

/** A module folder (and the dirs around it) for the guard and createModules. */
function makeRoot(extra = {}, { lock = LOCK, withRuntimeFiles = true } = {}) {
  const dir = tmp('hub-h-');
  const root = path.join(dir, 'root'); const md = path.join(root, 'demo');
  fs.mkdirSync(md, { recursive: true });
  fs.writeFileSync(path.join(md, 'module.json'), JSON.stringify({ ...BASE, ...extra }));
  fs.writeFileSync(path.join(md, 'setup.json'), JSON.stringify(SETUP));
  fs.writeFileSync(path.join(md, 'server.js'), SERVER);
  if (withRuntimeFiles) {
    fs.mkdirSync(path.join(md, 'runtime'));
    fs.writeFileSync(path.join(md, 'runtime', 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', private: true, dependencies: { a: '1.0.0' } }));
    fs.writeFileSync(path.join(md, 'runtime', 'package-lock.json'), JSON.stringify(lock));
  }
  return { dir, root, md, data: path.join(dir, 'modules') };
}

async function withGuard(extra, fn, { preInstall = false, env = {} } = {}) {
  const r = makeRoot(extra);
  if (preInstall) await installer.installRuntime({ dataDir: r.data, id: 'demo', moduleDir: r.md, runtime: { lockfile: 'runtime' }, runNpm: fakeCi() });
  const g = spawn(process.execPath, [GUARD, 'demo', '--root', r.root, '--data', r.data, '--state', path.join(r.dir, 'modules.json'), '--connectors', path.join(r.dir, 'connectors.json')],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, MYMAESTRO_HUB_SECRET: HUB_SECRET, MODULE_RUNTIME_DIR: '/forged', ...env } });
  const out = []; const err = []; let buf = '';
  g.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  g.stderr.on('data', d => err.push(String(d)));
  const send = (m) => g.stdin.write(JSON.stringify(m) + '\n');
  const until = async (f) => { for (let i = 0; i < 100; i++) { if (f()) return true; await new Promise(res => setTimeout(res, 50)); } return false; };
  const exited = new Promise(res => g.on('exit', c => res(c)));
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    await fn({ out, err, send, until, exited, dir: r.dir, data: r.data, call: async (id, name, args) => { send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }); assert.ok(await until(() => out.some(m => m.id === id))); return JSON.parse(out.find(m => m.id === id).result.content[0].text); } });
  } finally { g.kill(); rm(r.dir); }
}

// -- connectors rig with a fake client --
function rig(o = {}) {
  const dir = tmp('hub-hc-');
  const all = [];
  class FakeClient extends EventEmitter {
    constructor(command, args, opts) { super(); this.opts = opts; this.calls = []; this.responses = []; this.errors = []; all.push(this); }
    async connect() {} async listTools() { return [{ name: 'one' }]; } async disconnect() {}
    async callTool(name, args) { this.calls.push({ name, args }); return { content: [{ type: 'text', text: 'ok' }] }; }
    respond(id, result) { this.responses.push({ id, result }); }
    respondError(id, code, message) { this.errors.push({ id, code, message }); }
  }
  const cx = createConnectors({ file: path.join(dir, 'connectors.json'), keyFile: path.join(dir, '.auth-key'), McpClient: FakeClient, log: () => {}, unlockTtlMs: 0, baseEnv: { PATH: process.env.PATH }, leadNames: () => ['owner'], ...o });
  const up = (extra = {}) => cx.upsert({ id: 'rc', label: 'Remote computers', kind: 'mcp', command: process.execPath, args: ['x'], module: 'rc', enabled: true, ...extra }, { byModule: true });
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  return { cx, dir, all, up, tick, done: () => { cx.shutdown(); rm(dir); } };
}

/** An agent's tool call on connector `id` (already finished): the __call id the hub put in its arguments. */
async function callAs(r, agent, id = 'rc') {
  const s = (await r.cx.toolSpecsFor(agent)).find(x => x.connector === id);
  await s.handler({});
  const cl = r.all.find(c => c.calls.some(k => k.args.__call && c.calls[c.calls.length - 1] === k) && c.opts.env.CONNECTOR_ID === id);
  return { id: cl.calls[cl.calls.length - 1].args.__call, client: cl };
}

// ---- H1: caller identity ----
test('H1 manifest: server.callerIdentity is a boolean only', () => {
  const p = (extra) => manifestLib.validateManifest({ ...BASE, server: { ...BASE.server, ...extra } }, 'demo').problems.join('|');
  assert.strictEqual(p({ callerIdentity: true }), '');
  assert.strictEqual(p({ callerIdentity: false }), '');
  for (const bad of ['yes', 1, null, {}]) assert.match(p({ callerIdentity: bad }), /server\.callerIdentity must be true or false/);
});

test('H1 connectors: an agent cannot forge __agent; an opted-in module gets the real name; others get none', async () => {
  const r = rig();
  try {
    r.up({ callerIdentity: true });
    r.cx.upsert({ id: 'plain', kind: 'mcp', command: process.execPath, args: ['x'], enabled: true, agents: ['sam'] });
    r.cx.upsert({ id: 'rc2', label: 'Other', kind: 'mcp', command: process.execPath, args: ['x'], module: 'rc2', enabled: true, agents: ['sam'] }, { byModule: true });
    const spec = async (agent, id) => (await r.cx.toolSpecsFor(agent)).find(s => s.connector === id);
    await (await spec('owner', 'rc')).handler({ x: 1, __agent: 'forged', __hub: 'nope' });
    const c1 = r.all[0].calls[0].args;
    assert.strictEqual(c1.__agent, 'owner', 'the forged value is replaced by the real caller');
    assert.strictEqual(c1.x, 1);
    // a granted non-lead agent shows up under its own name
    r.cx.upsert({ id: 'rc', agents: ['sam'] }, { byModule: true });
    await (await spec('sam', 'rc')).handler({ __agent: 'owner' });
    assert.strictEqual(r.all[r.all.length - 1].calls.pop().args.__agent, 'sam');
    // a module that did not opt in: any __agent is removed
    await (await spec('sam', 'rc2')).handler({ __agent: 'owner', y: 2 });
    const rc2 = r.all.find(c => c.calls.some(k => k.args.y === 2));
    assert.deepStrictEqual(rc2.calls[0].args, { y: 2 });
    // a plain (non-module) connector is left alone
    await (await spec('sam', 'plain')).handler({ __agent: 'kept' });
    assert.strictEqual(r.all.find(c => c.calls.some(k => k.args.__agent === 'kept')).calls[0].args.__agent, 'kept');
  } finally { r.done(); }
});

test('H1 connectors: hub calls carry __hub and no __agent; a call outside any agent turn carries none', async () => {
  const r = rig();
  try {
    r.up({ callerIdentity: true });
    await r.cx.callTool('rc', 'one', { __agent: 'forged', a: 1 }, { hub: true });
    const a = r.all[0].calls[0].args;
    assert.strictEqual(a.a, 1);
    assert.match(a.__hub, /^[0-9a-f]{64}$/);
    assert.ok(!('__agent' in a));
    await r.cx.callTool('rc', 'one', { __agent: 'forged' });
    assert.ok(!('__agent' in r.all[0].calls[1].args));
    assert.ok(!('__hub' in r.all[0].calls[1].args));
    assert.throws(() => r.cx.upsert({ id: 'rc', callerIdentity: false }), /belongs to the/, 'module managed');
  } finally { r.done(); }
});

test('H1 guard: opted-in module sees __agent, others never; the audit names the agent for non-read calls', async () => {
  await withGuard({ server: { type: 'mcp-stdio', script: 'server.js', callerIdentity: true } }, async ({ call, dir, until }) => {
    const e = await call(2, 'echo', { __agent: 'ann', k: 1 });
    assert.deepStrictEqual(e.args, { k: 1, __agent: 'ann' });
    const p = await call(3, 'peek', { __agent: 'ann' });
    assert.strictEqual(p.args.__agent, 'ann');
    const bad = await call(4, 'echo', { __agent: 42 });
    assert.ok(!('__agent' in bad.args), 'only a string counts');
    await until(() => fs.existsSync(path.join(dir, 'modules', 'demo', 'audit.jsonl')) && /"decision":"done"/.test(fs.readFileSync(path.join(dir, 'modules', 'demo', 'audit.jsonl'), 'utf8')));
    const lines = fs.readFileSync(path.join(dir, 'modules', 'demo', 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const allowed = lines.find(l => l.decision === 'allowed' && l.args.k === 1);
    assert.strictEqual(allowed.agent, 'ann');
    assert.ok(!('__agent' in allowed.args), 'the name is a field of its own, not an argument');
    assert.strictEqual(lines.find(l => l.decision === 'done').agent, 'ann');
    assert.ok(!lines.some(l => l.tool === 'peek'), 'reads are not audited');
  });
  await withGuard({}, async ({ call, dir, until }) => {
    const e = await call(2, 'echo', { __agent: 'ann', k: 1 });
    assert.deepStrictEqual(e.args, { k: 1 }, 'second line of defence: removed in the guard too');
    await until(() => fs.existsSync(path.join(dir, 'modules', 'demo', 'audit.jsonl')));
    const l = fs.readFileSync(path.join(dir, 'modules', 'demo', 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(l.every(x => !('agent' in x)));
  });
});

test('R1 guard: __call is kept like __agent for an opted-in module (approvals), dropped for others, never audited, never from a hub call', async () => {
  const ID = '11111111-2222-4333-8444-555555555555';
  await withGuard({ approvals: true }, async ({ call, dir, until }) => {
    const e = await call(2, 'echo', { __call: ID, k: 1 });
    assert.deepStrictEqual(e.args, { k: 1, __call: ID });
    const p = await call(3, 'peek', { __call: ID });
    assert.strictEqual(p.args.__call, ID);
    assert.ok(!('__call' in (await call(4, 'echo', { __call: 42 })).args), 'only a string counts');
    assert.ok(!('__call' in (await call(5, 'echo', { __call: 'not an id' })).args), 'only an id shaped like the hub makes');
    await until(() => fs.existsSync(path.join(dir, 'modules', 'demo', 'audit.jsonl')) && /"decision":"done"/.test(fs.readFileSync(path.join(dir, 'modules', 'demo', 'audit.jsonl'), 'utf8')));
    // (this test server echoes its arguments as the reply, so the reply text of a "done" line is not looked at)
    const lines = fs.readFileSync(path.join(dir, 'modules', 'demo', 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const allowed = lines.filter(l => l.decision === 'allowed');
    assert.ok(allowed.length >= 1);
    assert.ok(allowed.every(l => !('__call' in l.args) && !JSON.stringify(l).includes(ID)), 'the call id is never written to the audit log');
  });
  await withGuard({}, async ({ call }) => {
    assert.deepStrictEqual((await call(2, 'echo', { __call: ID, k: 1 })).args, { k: 1 }, 'a module that did not opt in never sees it');
  });
  await withGuard({ approvals: true }, async ({ call }) => {
    assert.ok(!('__call' in (await call(2, 'echo', { __call: ID, __hub: HUB_SECRET })).args), 'a hub call carries none');
  });
});

// ---- H2: hub/approve ----
test('H2 manifest: approvals is a boolean only', () => {
  const p = (v) => manifestLib.validateManifest({ ...BASE, approvals: v }, 'demo').problems.join('|');
  assert.strictEqual(p(true), '');
  assert.strictEqual(p(false), '');
  for (const bad of ['yes', 1, null]) assert.match(p(bad), /approvals must be true or false/);
});

test('H2 guard: hub/approve passes up only when the manifest has approvals', async () => {
  for (const flag of [true, false]) {
    await withGuard(flag ? { approvals: true } : {}, async ({ send, out, err, until }) => {
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'peek', arguments: { ask: true } } });
      assert.ok(await until(() => out.some(m => m.id === 2)));
      assert.strictEqual(out.some(m => m.id === 'hub-9' && m.method === 'hub/approve'), flag);
      if (!flag) assert.ok(await until(() => err.join('').includes('-32601')), 'the server is told: method not found');
    });
  }
});

test('H2 connectors: allow, deny and timeout travel back; the request names the module and the agent', async () => {
  const asked = []; const answers = [{ decision: 'allow', by: 'owner' }, { decision: 'deny', by: 'owner' }, { decision: 'deny', by: 'timeout' }, { decision: 'deny', by: 'cancelled' }];
  const fake = { request: (spec) => { asked.push(spec); return { id: `ap${asked.length}`, promise: Promise.resolve(answers[asked.length - 1]) }; } };
  const clock = { t: 1000000 };
  const r = rig({ getApprovals: () => fake, now: () => clock.t });
  try {
    r.up({ approvals: true, agents: ['sam'] });
    const cl = (await callAs(r, 'sam')).client;
    for (let i = 1; i <= 4; i++) { const call = (await callAs(r, 'sam')).id; cl.emit('request', { id: i, method: 'hub/approve', params: { call, title: 'Open the door', detail: 'Because.', minutes: i === 1 ? 5 : undefined } }); await r.tick(); clock.t += 16000; }
    assert.deepStrictEqual(cl.responses.map(x => x.result.decision), ['allow', 'deny', 'timeout', 'deny']);
    assert.deepStrictEqual(cl.responses.map(x => x.id), [1, 2, 3, 4]);
    const s = asked[0];
    assert.deepStrictEqual([s.agent, s.tool, s.cls, s.summary, s.origin, s.timeoutMs], ['sam', 'rc', 'module', 'Open the door', 'module:rc', 300000]);
    assert.deepStrictEqual(s.detail, { module: 'Remote computers', text: 'Because.' }, 'the card shows the module display name');
    assert.deepStrictEqual(s.input, { title: 'Open the door' });
    assert.strictEqual(asked[1].timeoutMs, 240000, 'default 4 minutes');
  } finally { r.done(); }
});

test('R1 connectors: __call is added next to __agent for an opted-in module, never forged, dropped for others', async () => {
  const r = rig();
  try {
    r.up({ approvals: true, callerIdentity: true });
    r.cx.upsert({ id: 'rc2', label: 'Other', kind: 'mcp', command: process.execPath, args: ['x'], module: 'rc2', enabled: true, agents: ['sam'], callerIdentity: true }, { byModule: true });
    const spec = async (agent, id) => (await r.cx.toolSpecsFor(agent)).find(s => s.connector === id);
    await (await spec('owner', 'rc')).handler({ x: 1, __call: 'forged', __agent: 'forged' });
    const a = r.all[0].calls[0].args;
    assert.match(a.__call, /^[0-9a-f-]{36}$/);
    assert.strictEqual(a.__agent, 'owner');
    assert.strictEqual(a.x, 1);
    await (await spec('owner', 'rc')).handler({});
    assert.notStrictEqual(r.all[0].calls[1].args.__call, a.__call, 'a new id for every call');
    await (await spec('sam', 'rc2')).handler({ __call: 'forged', y: 2 });
    const rc2 = r.all.find(c => c.calls.some(k => k.args.y === 2));
    assert.deepStrictEqual(rc2.calls[0].args, { y: 2, __agent: 'sam' }, 'a module that did not opt in gets no __call, and a forged one is dropped');
    await r.cx.callTool('rc', 'one', { __call: 'forged' }, { hub: true });
    assert.ok(!('__call' in r.all[0].calls[2].args), 'a hub call carries none');
    await r.cx.callTool('rc', 'one', { __call: 'forged' });
    assert.ok(!('__call' in r.all[0].calls[3].args), 'a call outside an agent turn carries none');
  } finally { r.done(); }
});

test('R1 connectors: the agent on the card is the hub record of the call; unknown, other-connector and expired ids are refused', async () => {
  const asked = [];
  const fake = { request: (spec) => { asked.push(spec); return { id: 'x', promise: Promise.resolve({ decision: 'allow', by: 'owner' }) }; } };
  const clock = { t: 5000000 };
  const r = rig({ getApprovals: () => fake, now: () => clock.t });
  try {
    r.up({ approvals: true, agents: ['sam'] });
    r.cx.upsert({ id: 'rc2', label: 'Other', kind: 'mcp', command: process.execPath, args: ['x'], module: 'rc2', enabled: true, agents: ['sam'], approvals: true }, { byModule: true });
    const one = await callAs(r, 'sam', 'rc');
    const two = await callAs(r, 'sam', 'rc2');
    const ask = async (cl, params) => { const id = cl.responses.length + cl.errors.length + 1; cl.emit('request', { id, method: 'hub/approve', params }); await r.tick(); clock.t += 16000; return cl.errors.find(e => e.id === id) || cl.responses.find(x => x.id === id); };
    // a name the module sends is ignored: the hub's record of the caller wins
    const ok = await ask(one.client, { call: one.id, agent: 'owner', title: 'Open it' });
    assert.deepStrictEqual(ok.result, { decision: 'allow' });
    assert.strictEqual(asked[0].agent, 'sam');
    // no call id, a made-up one, another connector's: refused, nothing reaches the owner
    for (const call of [undefined, 'nope', '00000000-0000-4000-8000-000000000000', two.id]) {
      const e = await ask(one.client, { call, title: 'Open it' });
      assert.strictEqual(e.code, -32602, String(call));
      assert.match(e.message, call === undefined ? /needs call/ : /not tied to a live tool call/);
    }
    assert.strictEqual(asked.length, 1);
    // an old agent-only form is refused too
    assert.strictEqual((await ask(one.client, { agent: 'sam', title: 'Open it' })).code, -32602);
    // the id lives 5 seconds after its call returned
    const fresh = await callAs(r, 'sam', 'rc');
    clock.t += 4000;
    assert.deepStrictEqual((await ask(fresh.client, { call: fresh.id, title: 'again' })).result, { decision: 'allow' });
    const old = await callAs(r, 'sam', 'rc');
    clock.t += 6000;
    const gone = await ask(old.client, { call: old.id, title: 'late' });
    assert.strictEqual(gone.code, -32602);
    assert.match(gone.message, /not tied to a live tool call/);
    assert.strictEqual(asked.length, 2);
  } finally { r.done(); }
});

test('R1 connectors: an agent that lost access cannot ask; a running call keeps its id until it returns plus 5 s', async () => {
  const asked = [];
  const fake = { request: (spec) => { asked.push(spec); return { id: 'x', promise: Promise.resolve({ decision: 'allow', by: 'owner' }) }; } };
  const clock = { t: 9000000 };
  const r = rig({ getApprovals: () => fake, now: () => clock.t });
  try {
    r.up({ approvals: true, agents: ['sam'] });
    let release;
    const { id: call, client: cl } = await callAs(r, 'sam');
    // a call still running: hold the next one open
    cl.callTool = async function (name, args) { this.calls.push({ name, args }); await new Promise(res => { release = res; }); return { content: [{ type: 'text', text: 'ok' }] }; };
    const slow = (await r.cx.toolSpecsFor('sam')).find(s => s.connector === 'rc').handler({});
    await r.tick();
    const live = cl.calls[cl.calls.length - 1].args.__call;
    clock.t += 100000;   // inside the callTimeout + 60 s ceiling
    cl.emit('request', { id: 1, method: 'hub/approve', params: { call: live, title: 'during' } }); await r.tick();
    assert.deepStrictEqual(cl.responses[0].result, { decision: 'allow' }, 'a long call keeps its id while it runs');
    release(); await slow;
    clock.t += 16000;
    cl.emit('request', { id: 2, method: 'hub/approve', params: { call: live, title: 'after' } }); await r.tick();
    assert.strictEqual(cl.errors[0].code, -32602, 'more than 5 s after the call returned');
    assert.strictEqual(asked.length, 1);
  } finally { r.done(); }
});

test('R1 connectors: a lead that stopped being lead (no grant) is refused at approve time', async () => {
  const asked = [];
  const fake = { request: (spec) => { asked.push(spec); return { id: 'x', promise: Promise.resolve({ decision: 'allow', by: 'owner' }) }; } };
  const leads = ['owner'];
  const r = rig({ getApprovals: () => fake, leadNames: () => leads });
  try {
    r.up({ approvals: true, agents: [] });
    const { id: call, client: cl } = await callAs(r, 'owner');
    leads.length = 0;   // the connector is still running, the agent is no longer granted
    cl.emit('request', { id: 1, method: 'hub/approve', params: { call, title: 'revoked' } }); await r.tick();
    assert.strictEqual(cl.errors[0].code, -32000);
    assert.match(cl.errors[0].message, /no longer has access/);
    assert.strictEqual(asked.length, 0);
    leads.push('owner');
    cl.emit('request', { id: 2, method: 'hub/approve', params: { call, title: 'back' } }); await r.tick();
    assert.deepStrictEqual(cl.responses[0].result, { decision: 'allow' });
  } finally { r.done(); }
});

test('R1 connectors: at most 1 request per 15 s and 20 per hour per connector', async () => {
  const fake = { request: () => ({ id: 'x', promise: Promise.resolve({ decision: 'allow', by: 'owner' }) }) };
  const clock = { t: 20000000 };
  const r = rig({ getApprovals: () => fake, now: () => clock.t });
  try {
    r.up({ approvals: true, agents: ['sam'] });
    const cl = (await callAs(r, 'sam')).client;
    const ask = async () => { const call = (await callAs(r, 'sam')).id; const id = cl.responses.length + cl.errors.length + 1; cl.emit('request', { id, method: 'hub/approve', params: { call, title: 't' } }); await r.tick(); return cl.errors.find(e => e.id === id) || cl.responses.find(x => x.id === id); };
    assert.ok((await ask()).result);
    clock.t += 14000;
    const quick = await ask();
    assert.strictEqual(quick.code, -32000);
    assert.strictEqual(quick.message, 'Too many approvals asked; try again later');
    // 20 an hour: the 20th goes through at 16 s intervals (all inside the hour), the 21st is refused
    let n = 1;
    for (; n < 20; n++) { clock.t += 16000; const a = await ask(); assert.ok(a.result, `ask ${n + 1}`); }
    // keep the call alive: a new one for the clock now
    clock.t += 16000;
    const again = await callAs(r, 'sam');
    cl.emit('request', { id: 100, method: 'hub/approve', params: { call: again.id, title: 't' } }); await r.tick();
    assert.strictEqual(cl.errors.find(e => e.id === 100).message, 'Too many approvals asked; try again later');
    clock.t += 60 * 60 * 1000;
    const later = await callAs(r, 'sam');
    cl.emit('request', { id: 101, method: 'hub/approve', params: { call: later.id, title: 't' } }); await r.tick();
    assert.ok(cl.responses.find(x => x.id === 101), 'room again an hour later');
  } finally { r.done(); }
});

test('H2 connectors: refused without the flag, when disabled, and for bad parameters; strings are cleaned', async () => {
  const asked = [];
  const fake = { request: (spec) => { asked.push(spec); return { id: 'x', promise: Promise.resolve({ decision: 'allow', by: 'owner' }) }; } };
  const r = rig({ getApprovals: () => fake });
  try {
    r.up({ approvals: true, agents: ['sam'] });
    const { id: call, client: cl } = await callAs(r, 'sam');
    const ask = async (id, params) => { cl.emit('request', { id, method: 'hub/approve', params }); await r.tick(); };
    for (const [i, p] of [[1, {}], [2, { call }], [3, { call, title: '   ' }], [4, { call: 7, title: 't' }], [5, { call, title: 't', minutes: 0 }], [6, { call, title: 't', minutes: 6 }],
      [7, { call, title: 't', minutes: 1.5 }], [8, { call, title: 't', minutes: '5' }], [9, { call, title: 't', detail: 5 }], [10, null], [11, 'text'], [12, { call, title: 't', minutes: 60 }]]) {
      await ask(i, p);
      const e = cl.errors.find(x => x.id === i);
      assert.ok(e && e.code === -32602, `bad params ${i}`);
    }
    assert.strictEqual(asked.length, 0, 'nothing reached the owner');
    await ask(20, { call, title: `Line\u0000one\u001b[31m\n${'t'.repeat(200)}`, detail: `a\u0000b${'d'.repeat(900)}` });
    assert.strictEqual(asked.length, 1);
    assert.ok(asked[0].summary.length <= 80 && !/[\u0000-\u001f]/.test(asked[0].summary), 'title is one clean line of at most 80');
    assert.ok(asked[0].detail.text.length <= 600 && !asked[0].detail.text.includes('\u0000'));
    // a module without the flag
    r.up({ id: 'rc3', module: 'rc3', approvals: false });
    await r.cx.callTool('rc3', 'one', {});
    r.all[1].emit('request', { id: 1, method: 'hub/approve', params: { call, title: 't' } }); await r.tick();
    assert.strictEqual(r.all[1].errors[0].code, -32601);
    // a switched-off connector (started by setup) is refused
    r.up({ id: 'rc4', module: 'rc4', approvals: true, enabled: false });
    await r.cx.callTool('rc4', 'one', {});
    r.all[2].emit('request', { id: 1, method: 'hub/approve', params: { call, title: 't' } }); await r.tick();
    assert.strictEqual(r.all[2].errors[0].code, -32000);
    assert.match(r.all[2].errors[0].message, /switched off/);
    assert.strictEqual(asked.length, 1);
  } finally { r.done(); }
});

test('H2 connectors: at most 3 open requests per module', async () => {
  const pend = [];
  const fake = { request: () => ({ id: 'x', promise: new Promise(res => pend.push(res)) }) };
  const clock = { t: 30000000 };
  const r = rig({ getApprovals: () => fake, now: () => clock.t });
  try {
    r.up({ approvals: true, agents: ['sam'] });
    const cl = (await callAs(r, 'sam')).client;
    const ask = async (id) => { const call = (await callAs(r, 'sam')).id; cl.emit('request', { id, method: 'hub/approve', params: { call, title: 't' } }); await r.tick(); clock.t += 16000; };
    for (let i = 1; i <= 4; i++) await ask(i);
    assert.strictEqual(pend.length, 3);
    assert.strictEqual(cl.errors.length, 1);
    assert.match(cl.errors[0].message, /waiting for the owner/);
    pend.forEach(res => res({ decision: 'allow' })); await r.tick();
    await ask(5);
    assert.strictEqual(pend.length, 4, 'room again once they are answered');
  } finally { r.done(); }
});

test('R1 connectors: open approvals are denied when the module exits, stops, is switched off or locked', async () => {
  for (const how of ['exit', 'stop', 'disable', 'lock']) {
    const events = [];
    const ap = createApprovals({ onEvent: (e) => events.push(e), log: () => {} });
    const r = rig({ getApprovals: () => ap });
    try {
      if (how === 'lock') r.cx.upsert({ id: 'rc', label: 'Remote computers', kind: 'mcp', command: process.execPath, args: ['x'], module: 'rc', enabled: true, approvals: true, agents: ['sam'], protect: 'own' }, { byModule: true, newPassphrase: 'longenough1' });
      else r.up({ approvals: true, agents: ['sam'] });
      const { id: call, client: cl } = await callAs(r, 'sam');
      cl.emit('request', { id: 1, method: 'hub/approve', params: { call, title: 'Open' } }); await r.tick();
      assert.strictEqual(ap.list().length, 1, how);
      if (how === 'exit') cl.emit('exit', { code: 1 });
      else if (how === 'stop') r.cx.stop('rc');
      else if (how === 'disable') r.cx.upsert({ id: 'rc', enabled: false }, { byModule: true });
      else r.cx.lock('rc');
      await r.tick();
      assert.strictEqual(ap.list().length, 0, `no orphan card after ${how}`);
      assert.ok(events.some(e => e.type === 'approval_resolved' && e.decision === 'deny'), how);
    } finally { r.done(); }
  }
});

test('R1 approvals: a module request ignores "remember" and cancelOrigin denies by origin only', async () => {
  const allowances = { added: [], add(k, ms) { this.added.push([k, ms]); } };
  const ap = createApprovals({ allowances, log: () => {} });
  const a = ap.request({ agent: 'sam', tool: 'rc', input: {}, cls: 'module', summary: 's', allowKey: 'sam|module', origin: 'module:rc' });
  const out = ap.resolve(a.id, 'allow', { remember: '1h' });
  assert.strictEqual(out.remember, null);
  assert.deepStrictEqual(allowances.added, []);
  const b = ap.request({ agent: 'sam', tool: 'rc', input: { n: 1 }, cls: 'module', summary: 's', origin: 'module:rc' });
  const c = ap.request({ agent: 'sam', tool: 'x', input: {}, cls: 'send', summary: 's', origin: 'module:other' });
  const d = ap.request({ agent: 'sam', tool: 'y', input: {}, cls: 'send', summary: 's' });
  assert.strictEqual(ap.cancelOrigin('module:rc'), 1);
  assert.deepStrictEqual(await b.promise, { decision: 'deny', by: 'cancelled', remember: null });
  assert.strictEqual(ap.list().length, 2);
  ap.resolve(c.id, 'deny'); ap.resolve(d.id, 'deny');
});

test('R1 cards: module requests do not offer "remember" on the desktop or the phone', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const mob = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
  assert.match(app, /ev\.cls === 'module' \? '' : '<button class="allow-1h"/);
  assert.match(mob, /ev\.cls === 'module' \? '' : '<button class="ok1h"/);
});

test('H2 approvals: a module request uses its own wait, shows on the hub event stream without approvalsEnabled, and times out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const ap = createApprovals({ onEvent: (e) => events.push(e), log: () => {} });
  const clock = { t: 40000000 };
  const r = rig({ getApprovals: () => ap, now: () => clock.t });
  try {
    r.up({ approvals: true, agents: ['sam'] });
    const first = await callAs(r, 'sam');
    const cl = first.client;
    cl.emit('request', { id: 1, method: 'hub/approve', params: { call: first.id, title: 'Wake the laptop', minutes: 2 } });
    await r.tick();
    const ev = events.find(e => e.type === 'approval_request');
    assert.ok(ev, 'approval_request is published: desktop and phone cards and push all listen to it');
    assert.deepStrictEqual([ev.agent, ev.cls, ev.tool, ev.origin, ev.summary, ev.detail.module], ['sam', 'module', 'rc', 'module:rc', 'Wake the laptop', 'Remote computers']);
    assert.strictEqual(Date.parse(ev.expiresAt) - Date.parse(ev.createdAt), 120000);
    assert.strictEqual(ap.list().length, 1);
    t.mock.timers.tick(120000);
    await r.tick();
    assert.deepStrictEqual(cl.responses[0].result, { decision: 'timeout' });
    assert.strictEqual(ap.list().length, 0);
    // and an owner answer
    clock.t += 16000;
    cl.emit('request', { id: 2, method: 'hub/approve', params: { call: (await callAs(r, 'sam')).id, title: 'Again' } });
    await r.tick();
    assert.ok(ap.resolve(ap.list()[0].id, 'allow').ok);
    await r.tick();
    assert.deepStrictEqual(cl.responses[1].result, { decision: 'allow' });
  } finally { r.done(); }
});

test('H2 approvals: request() without a timeout option keeps the settings window', () => {
  const ap = createApprovals({ timeoutMs: 90000, log: () => {} });
  const a = ap.request({ agent: 'x', tool: 't', input: {}, cls: 'send', summary: 's' });
  const rec = ap.get(a.id);
  assert.strictEqual(Date.parse(rec.expiresAt) - Date.parse(rec.createdAt), 90000);
  ap.resolve(a.id, 'deny');
});

test('H2 push: a module request reaches the phone and names the module and the agent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createPush, QUESTION_DELAY_MS } = require('../lib/push');
  const dir = tmp('hub-hp-'); const sent = [];
  try {
    const push = createPush({ dir, now: () => 1_000_000, minGapMs: 20000, displayName: (a) => ({ sam: 'Sam' }[a] || a),
      webpush: { generateVAPIDKeys: () => ({ publicKey: 'PUBKEY', privateKey: 'PRIVKEY' }) },
      sender: async (sub, body) => { sent.push(JSON.parse(body)); } });
    push.subscribe({ endpoint: 'https://push.example.test/send/1', keys: { p256dh: 'BPkey1', auth: 'auth1' } });
    push.onEvent({ type: 'approval_request', id: 'ap1', agent: 'sam', cls: 'module', tool: 'rc', summary: 'Wake the laptop', detail: { module: 'Remote computers', text: 'x' } });
    t.mock.timers.tick(QUESTION_DELAY_MS); await new Promise(r => setImmediate(r));
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].title, 'Sam needs your OK');
    assert.match(sent[0].body, /^Remote computers: Wake the laptop/);
  } finally { rm(dir); }
});

// ---- H3: media "common" ----
test('H3 manifest: media is true, false or "common"', () => {
  const p = (v) => manifestLib.validateManifest({ ...BASE, media: v }, 'demo').problems.join('|');
  for (const ok of [true, false, 'common']) assert.strictEqual(p(ok), '');
  for (const bad of ['all', 'Common', 1, null]) assert.match(p(bad), /media must be true or false \(or "common"/);
});

function modulesRig(extra, { runNpm } = {}) {
  const r = makeRoot(extra);
  const conns = new Map();
  const connectors = {
    list: () => ({ connectors: [...conns.values()].map(c => ({ ...c, secretNames: [] })) }),
    upsert: (spec) => { const c = { agents: [], ...(conns.get(spec.id) || {}), ...spec }; conns.set(spec.id, c); return c; },
    stop: () => {}, startBackground: () => [], remove: (id) => conns.delete(id), readSecrets: () => ({}),
  };
  const mods = createModules({ root: r.root, dataDir: r.data, stateFile: path.join(r.dir, 'modules.json'), connectorsFile: path.join(r.dir, 'connectors.json'), connectors, listAgents: () => [], publish: () => {}, log: () => {}, runNpm });
  return { ...r, mods, conns, cleanup: () => rm(r.dir) };
}

test('H3 modules: media "common" makes the folder <hub home>/share/common/<id>; no media sets none', async () => {
  const r = modulesRig({ media: 'common' });
  try {
    await r.mods.runStep('demo', 'install', {});
    const want = path.join(HUB_HOME, 'share', 'common', 'demo');
    assert.strictEqual(r.conns.get('demo').mediaDir, want);
    assert.strictEqual(r.mods.mediaDirFor('demo'), want, 'notices read media from the same folder');
  } finally { r.cleanup(); }
  const r2 = modulesRig({});
  try {
    await r2.mods.runStep('demo', 'install', {});
    assert.strictEqual(r2.conns.get('demo').mediaDir, undefined);
  } finally { r2.cleanup(); }
});

test('H3 connectors: the common folder gets the same checks and mode as today (made 0775, a link is refused)', async () => {
  const r = rig();
  try {
    const share = path.join(r.dir, 'share', 'common');
    r.up({ mediaDir: path.join(share, 'rc') });
    await r.cx.callTool('rc', 'one', {});
    assert.strictEqual(r.all[0].opts.env.CONNECTOR_MEDIA_DIR, path.join(share, 'rc'));
    const st = fs.statSync(path.join(share, 'rc'));
    assert.ok(st.isDirectory());
    assert.strictEqual(st.mode & 0o777, 0o775 & ~process.umask());
    // a link in its place is refused and the server is not started
    r.cx.stop('rc');
    const target = path.join(r.dir, 'elsewhere'); fs.mkdirSync(target);
    r.up({ id: 'lk', module: 'lk', mediaDir: path.join(share, 'lk') });
    fs.symlinkSync(target, path.join(share, 'lk'));
    await assert.rejects(r.cx.callTool('lk', 'one', {}), /not a plain folder/);
    assert.strictEqual(r.all.length, 1);
  } finally { r.done(); }
});

// ---- H4: lockfile runtime ----
test('H4 manifest: runtime shape', () => {
  const p = (rt) => manifestLib.validateManifest({ ...BASE, runtime: rt }, 'demo').problems.join('|');
  assert.strictEqual(p({ lockfile: 'runtime' }), '');
  assert.strictEqual(p({ lockfile: 'runtime', timeoutSec: 60 }), '');
  assert.strictEqual(p({ lockfile: 'a/b', timeoutSec: 1800 }), '');
  for (const bad of [{ lockfile: '../x' }, { lockfile: '/etc' }, { lockfile: 'a/../../x' }, { lockfile: '' }, {}, 'runtime', null, [], { lockfile: 'C:\\x' }]) assert.match(p(bad), /runtime/, JSON.stringify(bad));
  for (const bad of [59, 1801, 1.5, '900', null]) assert.match(p({ lockfile: 'runtime', timeoutSec: bad }), /runtime\.timeoutSec must be a whole number from 60 to 1800/);
  assert.strictEqual(manifestLib.runtimeTimeoutMs({ lockfile: 'r' }), 900000);
  assert.strictEqual(manifestLib.runtimeTimeoutMs({ lockfile: 'r', timeoutSec: 120 }), 120000);
});

test('H4 validation against the module folder: files, lockfile version, integrity', () => {
  const load = (opts, extra = { runtime: { lockfile: 'runtime' } }) => { const r = makeRoot(extra, opts); try { return manifestLib.loadModule(r.md).problems.join('|'); } finally { rm(r.dir); } };
  assert.strictEqual(load({}), '');
  assert.match(load({ withRuntimeFiles: false }), /runtime\.lockfile "runtime": the folder is missing/);
  assert.match(load({ lock: { ...LOCK, lockfileVersion: 1 } }), /lockfileVersion 2 or 3/);
  assert.strictEqual(load({ lock: { ...LOCK, lockfileVersion: 2 } }), '');
  const noInt = JSON.parse(JSON.stringify(LOCK)); delete noInt.packages['node_modules/a'].integrity;
  assert.match(load({ lock: noInt }), /no integrity for node_modules\/a/);
  const local = JSON.parse(JSON.stringify(LOCK)); delete local.packages['node_modules/a'].integrity; delete local.packages['node_modules/a'].resolved;
  assert.strictEqual(load({ lock: local }), '', 'an entry without a resolved address (a workspace link) needs no integrity');
  assert.match(load({}, { runtime: { lockfile: '../runtime' } }), /runtime\.lockfile must be a folder inside/);
  // a missing file
  const r = makeRoot({ runtime: { lockfile: 'runtime' } });
  try {
    fs.rmSync(path.join(r.md, 'runtime', 'package-lock.json'));
    assert.match(manifestLib.loadModule(r.md).problems.join('|'), /runtime\/package-lock\.json is missing/);
    fs.writeFileSync(path.join(r.md, 'runtime', 'package-lock.json'), '{nope');
    assert.match(manifestLib.loadModule(r.md).problems.join('|'), /not valid JSON/);
  } finally { rm(r.dir); }
  // the folder is a link out of the module
  const r2 = makeRoot({ runtime: { lockfile: 'runtime' } });
  try {
    const out = path.join(r2.dir, 'outside'); fs.renameSync(path.join(r2.md, 'runtime'), out);
    fs.symlinkSync(out, path.join(r2.md, 'runtime'));
    assert.match(manifestLib.loadModule(r2.md).problems.join('|'), /inside the module folder/);
  } finally { rm(r2.dir); }
});

test('H4 installer: copies the two files, runs npm ci with the safe flags and the module time limit, records the state', async () => {
  const r = makeRoot({ runtime: { lockfile: 'runtime', timeoutSec: 120 } });
  try {
    const calls = [];
    const runNpm = fakeCi((args, cwd, opts) => { calls.push({ args, cwd, opts, files: fs.readdirSync(cwd).sort() }); });
    const rt = { lockfile: 'runtime', timeoutSec: 120 };
    assert.strictEqual(installer.runtimeInstalled(r.data, 'demo', { moduleDir: r.md, runtime: rt }), false);
    const res = await installer.installRuntime({ dataDir: r.data, id: 'demo', moduleDir: r.md, runtime: rt, runNpm });
    const dir = path.join(r.data, 'demo', 'runtime');
    assert.strictEqual(res.dir, dir);
    assert.deepStrictEqual(calls[0].args, ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund']);
    assert.strictEqual(calls[0].cwd, dir);
    assert.deepStrictEqual(calls[0].files, ['package-lock.json', 'package.json']);
    assert.strictEqual(calls[0].opts.timeoutMs, 120000);
    assert.ok(calls[0].opts.maxBuffer >= 32 * 1024 * 1024, 'npm output is not cut at the 8 MB of a single install');
    assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'package-lock.json')), fs.readFileSync(path.join(r.md, 'runtime', 'package-lock.json')));
    assert.strictEqual(installer.runtimeInstalled(r.data, 'demo', { moduleDir: r.md, runtime: rt }), true);
    // already installed: npm is not run again
    assert.match((await installer.installRuntime({ dataDir: r.data, id: 'demo', moduleDir: r.md, runtime: rt, runNpm })).log, /already/);
    assert.strictEqual(calls.length, 1);
    // the module ships a new lockfile: the old install no longer counts and is made again
    const lock2 = JSON.parse(JSON.stringify(LOCK)); lock2.packages['node_modules/a'].version = '1.0.1';
    fs.writeFileSync(path.join(r.md, 'runtime', 'package-lock.json'), JSON.stringify(lock2));
    assert.strictEqual(installer.runtimeInstalled(r.data, 'demo', { moduleDir: r.md, runtime: rt }), false);
    await installer.installRuntime({ dataDir: r.data, id: 'demo', moduleDir: r.md, runtime: rt, runNpm });
    assert.strictEqual(calls.length, 2);
    // uninstall removes it
    installer.uninstall(r.data, 'demo');
    assert.ok(!fs.existsSync(dir));
  } finally { rm(r.dir); }
});

test('H4 installer: a failed npm ci leaves nothing that looks installed; a bad lockfile is refused before npm runs; Node gate', async () => {
  const r = makeRoot({});
  try {
    const rt = { lockfile: 'runtime' };
    await assert.rejects(installer.installRuntime({ dataDir: r.data, id: 'demo', moduleDir: r.md, runtime: rt, runNpm: async () => { throw new Error('npm ci failed: boom'); } }), /boom/);
    assert.ok(!fs.existsSync(path.join(r.data, 'demo', 'runtime')));
    assert.strictEqual(installer.runtimeInstalled(r.data, 'demo'), false);
    fs.writeFileSync(path.join(r.md, 'runtime', 'package-lock.json'), JSON.stringify({ lockfileVersion: 1 }));
    let ran = false;
    await assert.rejects(installer.installRuntime({ dataDir: r.data, id: 'demo', moduleDir: r.md, runtime: rt, runNpm: async () => { ran = true; } }), /lockfileVersion 2 or 3/);
    assert.strictEqual(ran, false);
    await assert.rejects(installer.installRuntime({ dataDir: r.data, id: 'demo', moduleDir: r.md, runtime: { lockfile: '../x' }, runNpm: async () => 'x' }), /runtime/);
  } finally { rm(r.dir); }
});

test('H4 modules: the Install step installs the runtime; status asks for a reinstall when the folder is gone', async () => {
  const calls = [];
  const r = modulesRig({ runtime: { lockfile: 'runtime' } }, { runNpm: fakeCi((args, cwd) => { calls.push({ args, cwd }); }) });
  try {
    const step = await r.mods.runStep('demo', 'install', {});
    assert.strictEqual(step.result.runtime, true);
    assert.strictEqual(calls[0].args[0], 'ci');
    assert.strictEqual(r.conns.get('demo').runtimeDir, path.join(r.data, 'demo', 'runtime'));
    await r.mods.runStep('demo', 'done', {});
    assert.strictEqual(r.mods.list()[0].state, 'ready');
    assert.strictEqual(r.mods.detail('demo').installed, true);
    // a restore leaves out runtime/ (H5): the module needs an install again
    fs.rmSync(path.join(r.data, 'demo', 'runtime'), { recursive: true });
    const s = r.mods.list()[0];
    assert.strictEqual(s.state, 'attention');
    assert.strictEqual(s.note, 'Reinstall needed: open Data connectors and run Install again');
    assert.strictEqual(r.mods.detail('demo').installed, false);
    await r.mods.runStep('demo', 'install', {});
    assert.strictEqual(r.mods.list()[0].state, 'ready');
    // remove() takes the runtime with it
    r.mods.remove('demo');
    assert.ok(!fs.existsSync(path.join(r.data, 'demo', 'runtime')));
  } finally { r.cleanup(); }
});

test('H4 guard: MODULE_RUNTIME_DIR is the absolute runtime folder; a module without a runtime never gets one; a missing install stops the guard', async () => {
  await withGuard({ runtime: { lockfile: 'runtime' } }, async ({ call, data }) => {
    const p = await call(2, 'peek', {});
    assert.strictEqual(p.runtime, path.join(data, 'demo', 'runtime'));
    assert.ok(path.isAbsolute(p.runtime));
  }, { preInstall: true });
  await withGuard({}, async ({ call }) => {
    assert.strictEqual((await call(2, 'peek', {})).runtime, null, 'not even a value inherited from the hub');
  });
  await withGuard({ runtime: { lockfile: 'runtime' } }, async ({ exited, err }) => {
    assert.strictEqual(await exited, 1);
    assert.match(err.join(''), /Reinstall needed: open Data connectors and run Install again/);
  });
});

test('H4/H5 connectors: a module whose runtime install is missing is not started; the status says why, with no restart loop', async () => {
  const r = rig();
  try {
    const rtDir = path.join(r.dir, 'modules', 'rc', 'runtime');
    r.up({ runtimeDir: rtDir, background: true });
    await assert.rejects(r.cx.callTool('rc', 'one', {}), /Reinstall needed: open Data connectors and run Install again/);
    assert.strictEqual(r.all.length, 0, 'no process was spawned');
    assert.strictEqual(r.cx.list().connectors[0].lastError, 'Reinstall needed: open Data connectors and run Install again');
    fs.mkdirSync(rtDir, { recursive: true });
    fs.writeFileSync(path.join(rtDir, installer.RUNTIME_MARK), '{}');
    await r.cx.callTool('rc', 'one', {});
    assert.strictEqual(r.all.length, 1, 'starts once the install is there');
    assert.strictEqual(r.cx.list().connectors[0].lastError, null);
    assert.throws(() => r.cx.upsert({ id: 'rc', runtimeDir: '/x' }), /belongs to the/);
  } finally { r.done(); }
});

test('R1 installer: a damaged runtime is not "installed"; Install removes it and runs npm ci again', async () => {
  const r = makeRoot({});
  try {
    const rt = { lockfile: 'runtime' };
    const dir = path.join(r.data, 'demo', 'runtime');
    let runs = 0;
    const runNpm = fakeCi(() => { runs++; });
    const ok = () => installer.runtimeInstalled(r.data, 'demo', { moduleDir: r.md, runtime: rt });
    await installer.installRuntime({ dataDir: r.data, id: 'demo', moduleDir: r.md, runtime: rt, runNpm });
    assert.strictEqual(ok(), true);
    const damages = [
      ['node_modules is gone', () => fs.rmSync(path.join(dir, 'node_modules'), { recursive: true })],
      ['a dependency folder is gone', () => fs.rmSync(path.join(dir, 'node_modules', 'a'), { recursive: true })],
      ['a dependency has no package.json', () => fs.rmSync(path.join(dir, 'node_modules', 'a', 'package.json'))],
      ['a dependency is at another version', () => fs.writeFileSync(path.join(dir, 'node_modules', 'a', 'package.json'), JSON.stringify({ name: 'a', version: '9.9.9' }))],
      ['a dependency has no entry file', () => fs.rmSync(path.join(dir, 'node_modules', 'a', 'index.js'))],
      ['node_modules is a file', () => { fs.rmSync(path.join(dir, 'node_modules'), { recursive: true }); fs.writeFileSync(path.join(dir, 'node_modules'), 'x'); }],
    ];
    for (const [what, damage] of damages) {
      damage();
      assert.strictEqual(ok(), false, what);
      const before = runs;
      const res = await installer.installRuntime({ dataDir: r.data, id: 'demo', moduleDir: r.md, runtime: rt, runNpm });
      assert.doesNotMatch(res.log, /already installed/, what);
      assert.strictEqual(runs, before + 1, `npm ci ran again: ${what}`);
      assert.strictEqual(ok(), true, `repaired: ${what}`);
    }
  } finally { rm(r.dir); }
});

test('R1 installer: a lockfile whose dependency names climb out of node_modules never counts as installed', async () => {
  const lock = JSON.parse(JSON.stringify(LOCK)); lock.packages[''].dependencies = { '../escape': '1.0.0' }; lock.packages['node_modules/../escape'] = { version: '1.0.0' };
  const r = makeRoot({}, { lock });
  try {
    const dir = path.join(r.data, 'demo', 'runtime');
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock));
    fs.mkdirSync(path.join(dir, 'escape'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'escape', 'package.json'), JSON.stringify({ version: '1.0.0' }));
    fs.writeFileSync(path.join(dir, installer.RUNTIME_MARK), JSON.stringify({ lockSha256: require('crypto').createHash('sha256').update(fs.readFileSync(path.join(dir, 'package-lock.json'))).digest('hex') }));
    assert.strictEqual(installer.runtimeInstalled(r.data, 'demo'), false);
  } finally { rm(r.dir); }
});

test('R1 installer and modules: a second Install while one runs is refused', async () => {
  const r = makeRoot({});
  try {
    const rt = { lockfile: 'runtime' };
    let release; let started;
    const gate = new Promise(res => { started = res; });
    const first = installer.installRuntime({ dataDir: r.data, id: 'demo', moduleDir: r.md, runtime: rt, runNpm: async (a, cwd) => { started(); await new Promise(res => { release = res; }); return fakeCi()(a, cwd); } });
    await gate;
    await assert.rejects(installer.installRuntime({ dataDir: r.data, id: 'demo', moduleDir: r.md, runtime: rt, runNpm: fakeCi() }), /Install is already running/);
    release(); await first;
    // and it can run again afterwards
    assert.match((await installer.installRuntime({ dataDir: r.data, id: 'demo', moduleDir: r.md, runtime: rt, runNpm: fakeCi() })).log, /already installed/);
  } finally { rm(r.dir); }
  let release2; let started2;
  const gate2 = new Promise(res => { started2 = res; });
  const m = modulesRig({ runtime: { lockfile: 'runtime' } }, { runNpm: async (a, cwd) => { started2(); await new Promise(res => { release2 = res; }); return fakeCi()(a, cwd); } });
  try {
    const first = m.mods.runStep('demo', 'install', {});
    await gate2;
    await assert.rejects(m.mods.runStep('demo', 'install', {}), /Install is already running/);
    release2(); await first;
    await m.mods.runStep('demo', 'install', {});   // the lock was released
  } finally { m.cleanup(); }
});

// ---- H5: backups ----
test('H5 backup rules: runtime/ and pkg/ of a module are left out, everything else under data/modules stays', () => {
  const { DATA_LEAVE_OUT } = require('../lib/backup/collect');
  const out = (rel) => DATA_LEAVE_OUT.some(re => re.test(rel));
  for (const rel of ['modules/demo/runtime', 'modules/demo/runtime/node_modules/a/index.js', 'modules/demo/pkg', 'modules/demo/pkg/node_modules/x/package.json', 'modules/my-mod/runtime/package.json']) assert.ok(out(rel), rel);
  for (const rel of ['modules', 'modules/demo', 'modules/demo/home/keys.json', 'modules/demo/audit.jsonl', 'modules/demo/usage.json', 'modules/demo/runtime-notes.txt', 'modules/demo/home/runtime/x', 'modules/demo/pkgs/x', 'modules.json', 'runtime/x']) assert.ok(!out(rel), rel);
  // the speech engine's downloads (binaries, models, browser files, markers) are left out; lookalikes are not
  for (const rel of ['voice', 'voice/node_modules/sherpa-onnx-node/package.json', 'voice/models/whisper-tiny.en/x.onnx', 'voice/state.json', 'voice/.done/a.json']) assert.ok(out(rel), rel);
  for (const rel of ['voices.json', 'voice.json', 'voices/x', 'modules/demo/home/voice/x', 'agents/voice/x']) assert.ok(!out(rel), rel);
});

test('H5 snapshot: a real data tree keeps module homes and state and drops the installs', async () => {
  const collect = require('../lib/backup/collect');
  const dir = tmp('hub-h5-');
  try {
    const root = path.join(dir, 'app'); const hubHome = path.join(dir, 'hh'); const home = path.join(dir, 'home');
    const w = (...p) => { const f = path.join(root, 'data', ...p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); };
    fs.mkdirSync(hubHome, { recursive: true }); fs.mkdirSync(home, { recursive: true });
    w('settings.json'); w('modules', 'demo', 'home', 'keys.json'); w('modules', 'demo', 'audit.jsonl'); w('modules', 'demo', 'runtime', 'node_modules', 'a', 'index.js'); w('modules', 'demo', 'runtime', 'package.json'); w('modules', 'demo', 'pkg', 'node_modules', 'b', 'index.js');
    const snapDir = path.join(dir, 'snap'); fs.mkdirSync(snapDir);
    const snap = await collect.snapshot({ root, hubHome, home, platform: 'linux' }, snapDir, {});
    const paths = snap.entries.map(e => e.path || e.arch || '').join('\n');
    assert.match(paths, /data\/modules\/demo\/home\/keys\.json/);
    assert.match(paths, /data\/modules\/demo\/audit\.jsonl/);
    assert.doesNotMatch(paths, /modules\/demo\/runtime/);
    assert.doesNotMatch(paths, /modules\/demo\/pkg/);
  } finally { rm(dir); }
});
