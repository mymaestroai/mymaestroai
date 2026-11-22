'use strict';
// Remote computers, bundle 1 "getting ready": the accounts a switch to "without an administrator" must make, the helper-program download said plainly,
// and the check summaries / installer sentence while the server gets ready. Nothing runs MeshCentral or touches the network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMeshServer } = require('../modules/remote-computers/lib/meshserver');
const { ensureAgentFiles } = require('../modules/remote-computers/lib/agentfiles');
const { createRemote } = require('../modules/remote-computers/server');
const checks = require('../modules/remote-computers/index').checks;

const MODULE_DIR = path.join(__dirname, '..', 'modules', 'remote-computers');
const SETTINGS = { address_name: 'hub.example.ts.net', listen_ip: '100.64.0.10', control_port: 9971, agent_port: 9972, levels: ['maestro:look'], session_minutes: 30 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ready-'));
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
function fakeRuntime() {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'node_modules', 'meshcentral'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'meshcentral', 'meshcentral.js'), '// stand-in\n');
  return dir;
}
function fakeExec() {
  const calls = [];
  const execFile = (file, args, opts, cb) => {
    calls.push({ args });
    setImmediate(() => cb(null, 'Done.\n', ''));
    return { kill() { return true; } };
  };
  execFile.calls = calls;
  return execFile;
}
const verbs = (execFile) => execFile.calls.map((c) => c.args.find((a) => /^--(createaccount|resetaccount|adminaccount)$/.test(a)) + ' ' + c.args[c.args.indexOf(c.args.find((a) => /^--(createaccount|resetaccount|adminaccount)$/.test(a))) + 1]);
const mk = (mode, home, runtimeDir, over = {}) => createMeshServer({
  runtimeDir, home, settings: SETTINGS, mode, moduleDir: MODULE_DIR, ensureAgents: async () => {}, spawn: () => { throw new Error('no spawn'); },
  execFile: over.execFile || (() => { throw new Error('no execFile'); }), probe: async () => true, log: () => {}, ...over,
});

// ── part 1: the accounts ──
test('part 1: a service bootstrap then a hub bootstrap makes admin and maestro, rewrites accounts.json and removes the request file', async () => {
  const home = tmp(), runtimeDir = fakeRuntime();
  const svc = mk('service', home, runtimeDir);
  const prep = await svc.bootstrap();
  assert.strictEqual(prep.needsService, true);
  const before = JSON.parse(fs.readFileSync(svc.paths.accountsFile, 'utf8'));
  assert.ok(fs.existsSync(svc.paths.request));
  const execFile = fakeExec();
  const hub = mk('hub', home, runtimeDir, { execFile });
  const r = await hub.bootstrap();
  assert.deepStrictEqual(r, { created: true });
  assert.deepStrictEqual(verbs(execFile), ['--createaccount admin', '--adminaccount admin', '--createaccount maestro']);
  const after = JSON.parse(fs.readFileSync(hub.paths.accountsFile, 'utf8'));
  assert.strictEqual(after.admin.user, 'admin');
  assert.strictEqual(after.agent.user, 'maestro');
  assert.notStrictEqual(after.admin.pass, before.admin.pass, 'fresh passwords');
  assert.notStrictEqual(after.agent.pass, before.agent.pass);
  assert.ok(!fs.existsSync(svc.paths.request), 'the stale request (it holds password hashes) is removed');
  assert.ok(!execFile.calls.some((c) => c.args.some((a) => a.includes(after.admin.pass) || a.includes(after.agent.pass))), 'no password on a command line');
  // now it has run: a second hub bootstrap changes nothing
  assert.deepStrictEqual(await hub.bootstrap(), { created: false });
  assert.strictEqual(execFile.calls.length, 3);
});

test('part 1: an account that exists already (an earlier attempt) is reset, not an error', async () => {
  const home = tmp(), runtimeDir = fakeRuntime();
  const svc = mk('service', home, runtimeDir);
  await svc.bootstrap();
  const execFile = fakeExec();
  const real = execFile;
  const exists = (file, args, opts, cb) => {
    if (args.includes('--createaccount') && args.includes('admin')) { real.calls.push({ args }); setImmediate(() => cb(null, 'User already exists.\n', '')); return { kill() {} }; }
    return real(file, args, opts, cb);
  };
  exists.calls = real.calls;
  const hub = mk('hub', home, runtimeDir, { execFile: exists });
  assert.deepStrictEqual(await hub.bootstrap(), { created: true });
  assert.deepStrictEqual(verbs(exists), ['--createaccount admin', '--resetaccount admin', '--adminaccount admin', '--createaccount maestro']);
  assert.ok(!fs.existsSync(svc.paths.request));
});

test('part 1: a hub bootstrap with accounts.json and no request runs nothing; so does one next to an installed service', async () => {
  const home = tmp(), runtimeDir = fakeRuntime();
  const execFile = fakeExec();
  const hub = mk('hub', home, runtimeDir, { execFile });
  assert.deepStrictEqual(await hub.bootstrap(), { created: true });
  const n = execFile.calls.length;
  assert.deepStrictEqual(await hub.bootstrap(), { created: false });
  assert.strictEqual(execFile.calls.length, n);
  // a request that has been run: installed.json beside it
  fs.mkdirSync(path.join(home, 'service'), { recursive: true });
  fs.writeFileSync(path.join(home, 'service', 'request.env'), 'MMR_VERSION=1\n');
  fs.writeFileSync(path.join(home, 'service', 'installed.json'), '{}\n');
  assert.deepStrictEqual(await hub.bootstrap(), { created: false });
  assert.strictEqual(execFile.calls.length, n);
  assert.ok(fs.existsSync(path.join(home, 'service', 'request.env')), 'left alone');
});

// ── part 2: the helper-program download ──
const sha = (b) => crypto.createHash('sha384').update(b).digest('hex');
test('part 2: ensureAgentFiles calls onProgress after each file with files and bytes of what is downloaded; good files are kept and not counted', async () => {
  const files = [['a.bin', Buffer.from('aaaa')], ['b.bin', Buffer.from('bbbbbb')], ['c.bin', Buffer.from('cc')]];
  const runtimeDir = tmp(), dir = path.join(runtimeDir, 'node_modules', 'meshcentral', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-defaults.json'), JSON.stringify({ schemaVersion: 1, releases: [{ repository: 'o/r', tag: 'v1', files: files.map(([n, d]) => ({ filename: n, asset: n, size: d.length, sha384: sha(d) })) }] }));
  fs.writeFileSync(path.join(dir, 'a.bin'), files[0][1]);   // already good
  const seen = [];
  const fetch = async (url) => new Response(files.find(([n]) => n === url.split('/').pop())[1], { status: 200 });
  await ensureAgentFiles({ runtimeDir, fetch, concurrency: 1, onProgress: (p) => seen.push(p) });
  const afterFiles = seen.filter((p) => p.done > 0);
  assert.deepStrictEqual(afterFiles, [{ done: 1, total: 2, bytes: 6, totalBytes: 8 }, { done: 2, total: 2, bytes: 8, totalBytes: 8 }]);
  assert.ok(seen.every((p) => Object.keys(p).sort().join() === 'bytes,done,total,totalBytes'));
  // a failing second file: what was downloaded is kept, the next run fetches only what is missing
  fs.rmSync(path.join(dir, 'b.bin')); fs.rmSync(path.join(dir, 'c.bin'));
  let n = 0;
  const flaky = async (url) => { if (++n === 2) throw new TypeError('fetch failed'); return fetch(url); };
  await assert.rejects(() => ensureAgentFiles({ runtimeDir, fetch: flaky, concurrency: 1, onProgress: () => { throw new Error('a broken callback must not matter'); } }), /the download failed/);
  assert.ok(fs.existsSync(path.join(dir, 'b.bin')), 'the file that came is kept');
  assert.ok(!fs.existsSync(path.join(dir, 'c.bin')));
  const again = []; let fetched = 0;
  await ensureAgentFiles({ runtimeDir, fetch: async (u) => { fetched++; return fetch(u); }, onProgress: (p) => again.push(p) });
  assert.strictEqual(fetched, 1);
  assert.deepStrictEqual(again.filter((p) => p.done > 0), [{ done: 1, total: 1, bytes: 2, totalBytes: 2 }]);
});

test('part 2: the mesh server keeps idle / downloading / done / failed and health data carries no path or address', async () => {
  const home = tmp(), runtimeDir = fakeRuntime();
  let release, fail = false;
  const gate = new Promise((r) => { release = r; });
  const ms = mk('service', home, runtimeDir, {
    ensureAgents: async ({ onProgress }) => { onProgress({ done: 1, total: 3, bytes: 5 * 1048576, totalBytes: 20 * 1048576 }); await gate; if (fail) throw new Error('alpha.bin: the download failed (ECONNRESET) from https://github.com/example/x/releases/download/v1/alpha.bin into /home/someone/.hub/runtime/agents'); },
  });
  assert.deepStrictEqual(ms.helpers(), { state: 'idle', bytes: 0, totalBytes: 0, error: null });
  const p = ms.bootstrap();
  await flush();
  assert.deepStrictEqual(ms.helpers(), { state: 'downloading', bytes: 5 * 1048576, totalBytes: 20 * 1048576, error: null });
  fail = true; release();
  await assert.rejects(p, /Could not download the MeshCentral agent files/);
  const h = ms.helpers();
  assert.strictEqual(h.state, 'failed');
  assert.strictEqual(h.bytes, 5 * 1048576);
  assert.match(h.error, /alpha\.bin: the download failed \(ECONNRESET\)/);
  assert.ok(!/https?:|github\.com|\/home\//.test(JSON.stringify(h)), JSON.stringify(h));
  // a later attempt that works
  const ok = mk('service', tmp(), fakeRuntime(), { ensureAgents: async ({ onProgress }) => { onProgress({ done: 3, total: 3, bytes: 7, totalBytes: 7 }); } });
  await ok.bootstrap();
  assert.deepStrictEqual(ok.helpers(), { state: 'done', bytes: 7, totalBytes: 7, error: null });
});

function serviceRemote(ensureAgents) {
  const home = tmp();
  const remote = createRemote({
    env: { MODULE_SETTINGS: JSON.stringify({ ...SETTINGS, run_as: 'service' }), CONNECTOR_DATA_HOME: home, MODULE_RUNTIME_DIR: fakeRuntime() },
    write: () => {}, log: () => {},
    deps: { platform: 'linux', mesh: { ensureAgents, probe: async () => false, spawn: () => { throw new Error('no spawn'); }, execFile: () => { throw new Error('no execFile'); } } },
  });
  return remote;
}

test('part 2: health returns helpers, and answers at once while the download runs', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const remote = serviceRemote(async ({ onProgress }) => { onProgress({ done: 0, total: 2, bytes: 3 * 1048576, totalBytes: 9 * 1048576 }); await gate; });
  const first = remote.callTool('health');   // this one starts the download and waits for it
  await flush();
  const h = await remote.callTool('health');   // must not wait for it
  assert.deepStrictEqual(h.helpers, { state: 'downloading', bytes: 3 * 1048576, totalBytes: 9 * 1048576, error: null });
  assert.strictEqual(h.ok, false);
  release();
  const done = await first;
  assert.strictEqual(done.helpers.state, 'done');
  await remote.stop();
});

test('part 2: after a failed download the next health starts it again in the background and says so', async () => {
  let calls = 0;
  const remote = serviceRemote(async () => { calls += 1; throw new Error('alpha.bin: the download failed (ENOTFOUND)'); });
  const first = await remote.callTool('health');
  assert.strictEqual(calls, 1);
  assert.strictEqual(first.helpers.state, 'failed');
  const second = await remote.callTool('health');
  assert.strictEqual(calls, 2, 'a look after a failure is a new try');
  assert.strictEqual(second.helpers.state, 'downloading');
  await flush();
  assert.strictEqual((await remote.callTool('health')).helpers.state, 'downloading', 'and again');
  await flush();
  await remote.stop();
});

// ── checks.server ──
const ctxOf = (health) => ({ settings: {}, parse: JSON.parse, callTool: async () => JSON.stringify(health) });
const BASE = { ok: false, mode: 'service', running: false, group: null, warnings: [], lastError: null };
const READY = 'The server is getting ready. This page shows it when it is ready.';

test('part 2: checks.server says the helper download plainly', async () => {
  const d = await checks.server(ctxOf({ ...BASE, helpers: { state: 'downloading', bytes: 12.34 * 1048576, totalBytes: 45 * 1048576, error: null } }));
  assert.strictEqual(d.ok, false);
  assert.strictEqual(d.retry, true);
  assert.strictEqual(d.summary, 'Getting the helper programs for the other computers: 12.3 of 45 MB. How long it takes depends on your connection.');
  const f = await checks.server(ctxOf({ ...BASE, lastError: 'Could not download the MeshCentral agent files: x', helpers: { state: 'failed', bytes: 1, totalBytes: 2, error: 'alpha.bin: the download failed (ECONNRESET)' } }));
  assert.strictEqual(f.ok, false);
  assert.strictEqual(f.retry, undefined);
  assert.strictEqual(f.tryAgain, true);
  assert.strictEqual(f.summary, 'The helper programs for the other computers could not be downloaded from GitHub (alpha.bin: the download failed (ECONNRESET)). Check that the computer your Maestro runs on can reach github.com, then press Try again. What was already downloaded is kept.');
});

test('part 2: otherwise not ready (starting, group not ready) is the one plain sentence with retry', async () => {
  for (const h of [{ ...BASE, helpers: { state: 'done', bytes: 1, totalBytes: 1, error: null } }, { ...BASE, running: true, helpers: { state: 'idle', bytes: 0, totalBytes: 0, error: null } }, { ...BASE, running: true, group: 'mesh//g', ok: false }]) {
    const r = await checks.server(ctxOf(h));
    assert.deepStrictEqual([r.ok, r.retry, r.summary], [false, true, READY], JSON.stringify(h));
  }
  // an error that needs a person is still its own text, not retried
  const e = await checks.server(ctxOf({ ...BASE, lastError: 'boom' }));
  assert.strictEqual(e.retry, undefined);
  assert.match(e.summary, /boom/);
  // a ready server ignores helpers
  const ok = await checks.server(ctxOf({ ...BASE, ok: true, running: true, group: 'mesh//g', computers: 0, online: 0, helpers: { state: 'failed', error: 'x' } }));
  assert.strictEqual(ok.ok, true);
});

// ── part 3: Add a computer ──
test('part 3: Add a computer while the server is getting ready says to come back, in both the text and the thrown form', async () => {
  const want = 'The server is still getting ready. Come back to this step when Set it up says it is done.';
  const a = await checks.installer({ settings: {}, parse: (t) => { try { return JSON.parse(t); } catch { return null; } }, callTool: async () => 'The Remote computers server is not ready yet. Try again in a minute.' });
  assert.deepStrictEqual([a.ok, a.summary], [false, want]);
  const b = await checks.installer({ settings: {}, parse: () => null, callTool: async () => { throw new Error('The Remote computers server is not ready yet. Try again in a minute.'); } });
  assert.deepStrictEqual([b.ok, b.summary], [false, want]);
  const other = await checks.installer({ settings: {}, parse: () => null, callTool: async () => 'Save the tailnet name of My Maestro\'s computer in the settings first.' });
  assert.match(other.summary, /tailnet name/);
});
