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
test('part 1: a service bootstrap then a hub bootstrap makes admin and maestro with the passwords already in accounts.json, marks hubMade and leaves the request file', async () => {
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
  assert.strictEqual(after.admin.pass, before.admin.pass, 'the very same passwords: an install running at the same moment gets the same credentials');
  assert.strictEqual(after.agent.pass, before.agent.pass);
  assert.strictEqual(after.hubMade, true);
  assert.strictEqual(after.createdAt, before.createdAt, 'createdAt is kept');
  assert.ok(fs.existsSync(svc.paths.request), 'the request file is never removed (an install in progress may still read it)');
  assert.ok(!execFile.calls.some((c) => c.args.some((a) => a.includes(after.admin.pass) || a.includes(after.agent.pass))), 'no password on a command line');
  // the hashes handed to MeshCentral are those of the passwords in accounts.json
  const hashArgs = execFile.calls.map((c) => c.args[c.args.indexOf('--hashpass') + 1]).filter((a) => typeof a === 'string' && a.includes(','));
  assert.strictEqual(hashArgs.length, 2);
  // a second hub start with hubMade runs nothing, though the request is still there
  assert.deepStrictEqual(await hub.bootstrap(), { created: false });
  assert.strictEqual(execFile.calls.length, 3);
});

test('part 1 (round 3): person is carried over, createdAt kept, the passwords used are the ones in accounts.json (checked against the hashes)', async () => {
  const home = tmp(), runtimeDir = fakeRuntime();
  const svc = mk('service', home, runtimeDir);
  await svc.bootstrap();
  const file = svc.paths.accountsFile;
  const was = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...was, person: { user: 'person', pass: 'person-secret' }, createdAt: '2026-01-02T03:04:05.000Z' }, null, 2) + '\n');
  const requestBefore = fs.readFileSync(svc.paths.request, 'utf8');
  const execFile = fakeExec();
  const hub = mk('hub', home, runtimeDir, { execFile });
  assert.deepStrictEqual(await hub.bootstrap(), { created: true });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(after.person, { user: 'person', pass: 'person-secret' });
  assert.strictEqual(after.createdAt, '2026-01-02T03:04:05.000Z');
  assert.strictEqual(after.hubMade, true);
  assert.deepStrictEqual(after.admin, was.admin);
  assert.deepStrictEqual(after.agent, was.agent);
  // the hash MeshCentral got for each account verifies against the password in accounts.json (salt,hash form)
  const hashOf = (user) => { const c = execFile.calls.find((x) => x.args.includes('--createaccount') && x.args[x.args.indexOf('--createaccount') + 1] === user); return c.args[c.args.indexOf('--hashpass') + 1]; };
  const same = (arg, pass) => { const [salt, hash] = arg.split(','); return crypto.pbkdf2Sync(pass, salt, 12000, 128, 'sha384').toString('base64') === hash; };
  assert.ok(same(hashOf('admin'), was.admin.pass), 'admin hash is of the password in accounts.json');
  assert.ok(same(hashOf('maestro'), was.agent.pass), 'agent hash is of the password in accounts.json');
  assert.strictEqual(fs.readFileSync(svc.paths.request, 'utf8'), requestBefore, 'the request file is untouched');
});

test('part 1 (round 3): a failure in making an account leaves accounts.json exactly as it was, and the request file stays', async () => {
  const home = tmp(), runtimeDir = fakeRuntime();
  const svc = mk('service', home, runtimeDir);
  await svc.bootstrap();
  const textBefore = fs.readFileSync(svc.paths.accountsFile, 'utf8');
  const execFile = (file, args, opts, cb) => { setImmediate(() => cb(null, args.includes('--createaccount') && args.includes('maestro') ? 'No way.\n' : 'Done.\n', '')); return { kill() {} }; };
  const hub = mk('hub', home, runtimeDir, { execFile });
  await assert.rejects(() => hub.bootstrap(), /Could not create the agent account/);
  assert.strictEqual(fs.readFileSync(svc.paths.accountsFile, 'utf8'), textBefore);
  assert.ok(fs.existsSync(svc.paths.request));
});

test('part 1 (round 3): an accounts.json that cannot be used, with an un-run request, falls back to fresh passwords; without a request it still stops the start', async () => {
  const home = tmp(), runtimeDir = fakeRuntime();
  const svc = mk('service', home, runtimeDir);
  await svc.bootstrap();
  fs.writeFileSync(svc.paths.accountsFile, '{ not json');
  const execFile = fakeExec();
  const hub = mk('hub', home, runtimeDir, { execFile });
  assert.deepStrictEqual(await hub.bootstrap(), { created: true });
  const after = JSON.parse(fs.readFileSync(svc.paths.accountsFile, 'utf8'));
  assert.ok(after.admin.pass && after.agent.pass && after.hubMade === true);
  assert.ok(fs.existsSync(svc.paths.request));
  // no request: today's strict refusal of an unreadable file
  const home2 = tmp();
  fs.writeFileSync(path.join(home2, 'accounts.json'), '{ not json');
  const hub2 = mk('hub', home2, runtimeDir, { execFile: fakeExec() });
  await assert.rejects(() => hub2.bootstrap(), /could not be read/);
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
  assert.ok(fs.existsSync(svc.paths.request), 'the request file stays');
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

test('part 2 (round 3): the first service-mode health read answers at once with the progress, without waiting for the download; later reads join it', async () => {
  let release, calls = 0;
  const gate = new Promise((r) => { release = r; });
  const remote = serviceRemote(async ({ onProgress }) => { calls += 1; onProgress({ done: 0, total: 2, bytes: 3 * 1048576, totalBytes: 9 * 1048576 }); await gate; });
  const first = await remote.callTool('health');   // the gate is still shut: this must not wait for it
  assert.deepStrictEqual(first.helpers, { state: 'downloading', bytes: 3 * 1048576, totalBytes: 9 * 1048576, error: null });
  assert.strictEqual(first.ok, false);
  const h = await remote.callTool('health');
  assert.deepStrictEqual(h.helpers, { state: 'downloading', bytes: 3 * 1048576, totalBytes: 9 * 1048576, error: null });
  assert.strictEqual(calls, 1, 'one download, joined by the later read');
  release();
  await flush();
  const done = await remote.callTool('health');
  assert.strictEqual(done.helpers.state, 'done');
  assert.strictEqual(calls, 1);
  assert.strictEqual(done.reason, 'not-installed', 'once the helpers are done, health looks at the service');
  await remote.stop();
});

test('part 2 (round 3): repeated health reads after a failure stay failed with the reason and start nothing', async () => {
  let calls = 0;
  const remote = serviceRemote(async () => { calls += 1; throw new Error('alpha.bin: the download failed (ENOTFOUND)'); });
  const first = await remote.callTool('health');
  await flush();
  assert.strictEqual(calls, 1);
  for (let i = 0; i < 4; i++) {
    const h = await remote.callTool('health');
    await flush();
    assert.strictEqual(h.helpers.state, 'failed', `read ${i}`);
    assert.match(h.helpers.error, /alpha\.bin: the download failed \(ENOTFOUND\)/);
    assert.strictEqual(h.ok, false);
  }
  assert.strictEqual(calls, 1, 'a look never starts the download again');
  assert.ok(first.helpers.state === 'downloading' || first.helpers.state === 'failed');
  await remote.stop();
});

test('part 2 (round 3): { retry: true } after a failure starts the download once and answers at once with downloading; retry is ignored when nothing failed', async () => {
  let calls = 0, release;
  const remote = serviceRemote(async () => { calls += 1; if (calls === 1) throw new Error('alpha.bin: the download failed (ENOTFOUND)'); await new Promise((r) => { release = r; }); });
  await remote.callTool('health');
  await flush();
  assert.strictEqual((await remote.callTool('health')).helpers.state, 'failed');
  assert.strictEqual(calls, 1);
  const retried = await remote.callTool('health', { retry: true });
  assert.strictEqual(calls, 2, 'started once');
  assert.strictEqual(retried.helpers.state, 'downloading');
  const again = await remote.callTool('health', { retry: true });   // already downloading: joins, starts nothing
  assert.strictEqual(calls, 2);
  assert.strictEqual(again.helpers.state, 'downloading');
  await flush();
  release();
  await flush();
  const ok = await remote.callTool('health', { retry: true });   // done: nothing to retry
  assert.strictEqual(ok.helpers.state, 'done');
  assert.strictEqual(calls, 2);
  // a retry that is not exactly true does nothing
  let n = 0;
  const other = serviceRemote(async () => { n += 1; throw new Error('x: the download failed (E)'); });
  await other.callTool('health'); await flush();
  await other.callTool('health', { retry: 'yes' }); await flush();
  await other.callTool('health', {}); await flush();
  assert.strictEqual(n, 1);
  await remote.stop(); await other.stop();
});

test('part 2 (round 3): the health tool takes { retry: boolean } and nothing else is loosened', () => {
  const { TOOLS } = require('../modules/remote-computers/server');
  const health = TOOLS.find((t) => t.name === 'health');
  assert.deepStrictEqual(Object.keys(health.inputSchema.properties), ['retry']);
  assert.strictEqual(health.inputSchema.properties.retry.type, 'boolean');
  assert.strictEqual(health.inputSchema.additionalProperties, false);
  assert.ok(!health.inputSchema.required);
  for (const t of TOOLS) {
    if (t.name === 'health') continue;
    assert.strictEqual(t.inputSchema.additionalProperties, false, t.name);
    assert.ok(!('retry' in (t.inputSchema.properties || {})), t.name);
  }
});

test('part 2 (round 3): an early refusal that is not about the download resets failed to idle; a download failure stays failed', async () => {
  const runtimeDir = fakeRuntime();
  const settings = { ...SETTINGS };   // the server holds this very object, so a later change reaches it
  const ms = createMeshServer({ runtimeDir, home: tmp(), settings, mode: 'service', moduleDir: MODULE_DIR, ensureAgents: async () => { throw new Error('alpha.bin: the download failed (E)'); }, spawn: () => { throw new Error('no spawn'); }, execFile: () => { throw new Error('no execFile'); }, probe: async () => true, log: () => {} });
  await assert.rejects(() => ms.bootstrap(), /Could not download/);
  assert.strictEqual(ms.helpers().state, 'failed');
  settings.agent_allowed = '100.64.0.0/10\n100.65.0.0/10';   // refused before any download
  await assert.rejects(() => ms.bootstrap(), /allowed addresses are not valid/);
  assert.strictEqual(ms.helpers().state, 'idle', 'the page never shows an old download failure for a different cause');
  // a bad folder name (a quote in the module folder) is refused too, and also resets
  const settings2 = { ...SETTINGS };
  let n = 0;
  const quoted = createMeshServer({ runtimeDir, home: tmp(), settings: settings2, mode: 'service', moduleDir: path.join(tmp(), "it's"), ensureAgents: async () => { n += 1; throw new Error('alpha.bin: the download failed (E)'); }, spawn: () => { throw new Error('no spawn'); }, execFile: () => { throw new Error('no execFile'); }, probe: async () => true, log: () => {} });
  await assert.rejects(() => quoted.bootstrap(), /single quote/);
  assert.strictEqual(n, 0);
  assert.strictEqual(quoted.helpers().state, 'idle');
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

test('part 2 (round 3): checks.server asks health to retry only when its ctx has tryAgain: true', async () => {
  const asked = [];
  const ctx = (extra) => ({ settings: {}, parse: JSON.parse, callTool: async (name, args) => { asked.push([name, args]); return JSON.stringify(BASE); }, ...extra });
  await checks.server(ctx({}));
  await checks.server(ctx({ tryAgain: false }));
  await checks.server(ctx({ tryAgain: 'yes' }));
  assert.deepStrictEqual(asked, [['health', {}], ['health', {}], ['health', {}]]);
  asked.length = 0;
  await checks.server(ctx({ tryAgain: true }));
  assert.deepStrictEqual(asked, [['health', { retry: true }]]);
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
