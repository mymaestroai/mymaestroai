'use strict';
// Remote computers on a Mac: the platform gate, the private picture copies (off on a Mac, the /proc way on Linux) and the
// leftover-process check with `ps`. These run on any system: the Mac way is forced with options and stand-ins.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createShotStore, KEEP } = require('../modules/remote-computers/lib/shots');
const { createMeshServer, psCommandOf } = require('../modules/remote-computers/lib/meshserver');
const { createRemote } = require('../modules/remote-computers/server');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-mac-'));
const mode = (f) => fs.statSync(f).mode & 0o777;
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const SETTINGS = { run_as: 'hub', address_name: 'hub.example.ts.net', listen_ip: '100.101.102.103', control_port: 9971, agent_port: 9972, levels: ['owner:look'], session_minutes: 30 };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function fakeRuntime() {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'node_modules', 'meshcentral'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'meshcentral', 'meshcentral.js'), '// stand-in\n');
  return dir;
}

// ── the gate ─────────────────────────────────────────────────────────────────────────────────────
test('gate: on a Mac the server is supported, runs in hub mode and builds the mesh server', async () => {
  const remote = createRemote({
    env: { MODULE_SETTINGS: JSON.stringify(SETTINGS), CONNECTOR_DATA_HOME: tmp(), MODULE_RUNTIME_DIR: fakeRuntime() },
    write: () => {}, log: () => {}, deps: { platform: 'darwin', serviceSupported: true },
  });
  assert.strictEqual(remote.mode, 'hub');
  assert.ok(remote.mesh, 'MeshCentral is set up');
  assert.notStrictEqual(remote.state.phase, 'unsupported');
  const h = await remote.callTool('health');
  assert.notStrictEqual(h.waiting, 'Remote computers can\'t run on this system yet. It runs on Linux and Mac.');
  assert.ok(!h.warnings.some((w) => /On Linux, set/.test(w)), 'no advice about a Linux-only service on a Mac');
  await remote.stop();
});

test('gate: a Mac never picks the service mode on its own, even with auto and systemd reported', () => {
  const r = createRemote({
    env: { MODULE_SETTINGS: JSON.stringify({ ...SETTINGS, run_as: 'auto' }), CONNECTOR_DATA_HOME: tmp(), MODULE_RUNTIME_DIR: fakeRuntime() },
    write: () => {}, log: () => {}, deps: { platform: 'darwin', serviceSupported: () => true },
  });
  assert.strictEqual(r.mode, 'hub');
});

test('gate: Windows and other systems stay refused', () => {
  for (const platform of ['win32', 'freebsd']) {
    const r = createRemote({ env: { MODULE_SETTINGS: JSON.stringify(SETTINGS), CONNECTOR_DATA_HOME: tmp(), MODULE_RUNTIME_DIR: fakeRuntime() }, write: () => {}, log: () => {}, deps: { platform } });
    assert.strictEqual(r.state.phase, 'unsupported', platform);
    assert.strictEqual(r.mesh, null, platform);
  }
});

// ── the private picture copies: off on a Mac, the /proc way on Linux ────────────────────────────
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
const linuxStore = (home, over = {}) => createShotStore({ home, platform: 'linux', now: () => Date.UTC(2026, 10, 22, 12, 30, 15), ...over });

test('shots on a Mac (darwin and any other system): save and prune do nothing, write nothing, and say so once in the log', () => {
  for (const platform of ['darwin', 'win32', 'freebsd']) {
    const home = tmp(), said = [];
    const s = createShotStore({ home, platform, log: (...a) => said.push(a.join(' ')) });
    assert.strictEqual(s.save('pc1', JPEG), null, platform);
    assert.strictEqual(s.save('pc2', JPEG), null, platform);
    assert.strictEqual(s.prune('pc1'), 0, platform);
    assert.deepStrictEqual(fs.readdirSync(home), [], `${platform}: nothing was written`);
    assert.strictEqual(said.length, 1, `${platform}: said once: ${said.join(' | ')}`);
    assert.match(said[0], /off on this system/);
  }
});

test('shots on a Mac: no path-based way is left (nothing is made even without a data folder, and a link is not even looked at)', () => {
  const real = tmp(), parent = tmp(), link = path.join(parent, 'home');
  fs.symlinkSync(real, link);
  const s = createShotStore({ home: link, platform: 'darwin' });
  assert.strictEqual(s.save('pc1', JPEG), null);
  assert.deepStrictEqual(fs.readdirSync(real), [], 'nothing was written through the link');
  assert.strictEqual(createShotStore({ home: '', platform: 'darwin' }).save('pc1', JPEG), null);
});

test('shots on Linux: a picture is saved privately under screens/<computer>/<day>/, new file 0600, folders 0700', () => {
  const home = tmp();
  const r = linuxStore(home).save('Abcdefghijkl0123', JPEG);
  assert.ok(r.path.startsWith(path.join(home, 'screens', 'Abcdefghijkl') + path.sep));
  assert.deepStrictEqual(fs.readFileSync(r.path), JPEG);
  assert.strictEqual(mode(r.path), 0o600);
  for (const d of [path.join(home, 'screens'), path.dirname(path.dirname(r.path)), path.dirname(r.path)]) assert.strictEqual(mode(d), 0o700, d);
  assert.match(path.basename(r.path), /^\d{6}-[0-9a-f]{4}\.jpg$/);
});

test('shots on Linux: the default follows the system, and a link in place of the data folder is refused', () => {
  if (process.platform !== 'linux') return;
  const home = tmp();
  assert.ok(fs.existsSync(createShotStore({ home, now: () => Date.UTC(2026, 10, 22, 1, 2, 3) }).save('pc1', JPEG).path));
  const real = tmp(), parent = tmp(), link = path.join(parent, 'home');
  fs.symlinkSync(real, link);
  assert.throws(() => linuxStore(link).save('pc1', JPEG), (e) => e.code === 'ENOTPLAIN');
  assert.deepStrictEqual(fs.readdirSync(real), [], 'nothing was written through the link');
});

test('shots on Linux: a link as screens/, as the computer folder or as the day folder is refused and nothing is written outside', () => {
  const outside = tmp();
  for (const depth of ['screens', 'comp', 'day']) {
    const home = tmp();
    const s = linuxStore(home);
    if (depth === 'screens') fs.symlinkSync(outside, path.join(home, 'screens'));
    else {
      s.save('pc1', JPEG);   // makes screens/pc1/<day>
      const comp = path.join(home, 'screens', 'pc1');
      if (depth === 'comp') { fs.renameSync(comp, `${comp}.moved`); fs.symlinkSync(outside, comp); }
      else { const day = path.join(comp, fs.readdirSync(comp)[0]); fs.renameSync(day, `${day}.moved`); fs.symlinkSync(outside, day); }
    }
    assert.throws(() => s.save('pc1', JPEG), (e) => e.code === 'ENOTPLAIN', depth);
    assert.deepStrictEqual(fs.readdirSync(outside), [], `${depth}: nothing was written outside the store`);
  }
});

test('shots on Linux: the computer folder name is cleaned, and a name that cleans to nothing is refused', () => {
  const home = tmp();
  const r = linuxStore(home).save('../../etc/x', JPEG);
  assert.ok(r.path.startsWith(path.join(home, 'screens') + path.sep));
  assert.strictEqual(path.basename(path.dirname(path.dirname(r.path))), '______etc_x');
  assert.throws(() => linuxStore(home).save('', JPEG), (e) => e.code === 'ENOTPLAIN');
});

test('shots on Linux: each computer keeps its newest pictures only, and a link among the pictures is left alone', () => {
  const home = tmp();
  let t = Date.UTC(2026, 10, 22, 8, 0, 0);
  const s = createShotStore({ home, platform: 'linux', keep: 5, now: () => (t += 1000) });
  for (let i = 0; i < 9; i++) s.save('pc1', JPEG);
  const comp = path.join(home, 'screens', 'pc1');
  const files = () => fs.readdirSync(comp).flatMap((d) => fs.readdirSync(path.join(comp, d)));
  assert.strictEqual(files().length, 5);
  const outside = path.join(tmp(), 'keep');
  fs.writeFileSync(outside, 'x');
  const day = path.join(comp, fs.readdirSync(comp)[0]);
  fs.symlinkSync(outside, path.join(day, '000001-aaaa.jpg'));
  s.save('pc1', JPEG);
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'x', 'prune never follows a link');
  assert.ok(KEEP === 200);
});

// ── the leftover-process check on a Mac ──────────────────────────────────────────────────────────
function fakeSpawn() {
  const calls = [];
  const spawn = (file, args, opts) => {
    const p = new EventEmitter();
    p.pid = 4000 + calls.length; p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    p.kill = (sig) => { setImmediate(() => p.emit('exit', null, sig)); return true; };
    calls.push({ file, args, opts, proc: p });
    return p;
  };
  spawn.calls = calls;
  return spawn;
}
function newServer(over = {}) {
  const runtimeDir = over.runtimeDir || fakeRuntime(), home = over.home || tmp();
  const spawn = fakeSpawn();
  let t = 1000000;
  const timers = { setTimeout: (fn, ms) => setTimeout(fn, 0), clearTimeout: (h) => clearTimeout(h) };
  const ms = createMeshServer({ runtimeDir, home, settings: SETTINGS, spawn, now: () => (t += 5000), timers, probe: async () => true, log: () => {}, ...over });
  return { ms, spawn, home, runtimeDir };
}
const touchCert = (ms) => { fs.mkdirSync(ms.paths.dataPath, { recursive: true }); fs.writeFileSync(ms.paths.rootCert, 'cert'); };
async function startWith(s) { const p = s.ms.start(); for (let i = 0; i < 40; i++) await flush(); await p; }

test('leftover process (Mac): ps is asked for the pid; ours is stopped with SIGTERM, and the pid file then names the new process', async () => {
  const base = newServer({});
  const asked = [], sig = [];
  let alive = true;
  const line = `${process.execPath} ${base.ms.paths.mainJs} --datapath ${base.ms.paths.dataPath} --npmpath x`;
  const s = newServer({ home: base.home, runtimeDir: base.runtimeDir, platform: 'darwin', psCommand: (pid) => { asked.push(pid); return alive ? line : null; }, killPid: (pid, signal) => { sig.push([pid, signal]); alive = false; } });
  touchCert(s.ms);
  fs.writeFileSync(s.ms.paths.pidFile, '777\n');
  await startWith(s);
  assert.deepStrictEqual(sig, [[777, 'SIGTERM']]);
  assert.ok(asked.length >= 2 && asked.every((p) => p === 777));
  assert.strictEqual(fs.readFileSync(s.ms.paths.pidFile, 'utf8'), `${s.spawn.calls[0].proc.pid}\n`);
  await s.ms.stop();
});

test('leftover process (Mac): paths with spaces are matched whole; nothing else is ever signalled', async () => {
  const runtimeDir = tmp(), home = path.join(tmp(), 'Application Support', 'hub data');
  fs.mkdirSync(path.join(runtimeDir, 'node_modules', 'meshcentral'), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'node_modules', 'meshcentral', 'meshcentral.js'), '// stand-in\n');
  fs.mkdirSync(home, { recursive: true });
  const base = newServer({ home, runtimeDir });
  const mainJs = base.ms.paths.mainJs, data = base.ms.paths.dataPath;
  const cases = [
    ['another program', '/usr/bin/vim notes.txt', false],
    ['our script, another datapath', `node ${mainJs} --datapath /somewhere/else`, false],
    ['our datapath as a longer path', `node ${mainJs} --datapath ${data}-copy`, false],
    ['the datapath but not our script', `node /tmp/other.js --datapath ${data}`, false],
    ['our script inside a longer path', `node ${mainJs}.bak --datapath ${data}`, false],
    ['ours, plain', `node ${mainJs} --datapath ${data} --npmpath x`, true],
    ['ours, with spaces in every path (ps does not quote)', `/Applications/Node js/node ${mainJs} --datapath ${data} --npmpath x`, true],
    ['ours, paths quoted', `node "${mainJs}" --datapath ${data}`, true],
    ['a pid with no process', null, false],
  ];
  for (const [name, cmd, ours] of cases) {
    const sig = [];
    let gone = false;
    const s = newServer({ home, runtimeDir, platform: 'darwin', psCommand: () => (gone ? null : cmd), killPid: (pid, signal) => { sig.push([pid, signal]); gone = true; } });
    touchCert(s.ms);
    fs.writeFileSync(s.ms.paths.pidFile, '901\n');
    await startWith(s);
    assert.deepStrictEqual(sig, ours ? [[901, 'SIGTERM']] : [], name);
    await s.ms.stop();
  }
});

test('leftover process (Mac): ps that throws counts as "not ours"; pid 1 and the hub\'s own pid are never signalled; /proc is not read', async () => {
  const base = newServer({});
  for (const [pidText, ps] of [['1\n', () => 'init'], [`${process.pid}\n`, () => 'node'], ['902\n', () => { throw new Error('ps failed'); }]]) {
    const sig = [];
    const s = newServer({ home: base.home, runtimeDir: base.runtimeDir, platform: 'darwin', psCommand: ps, procRoot: path.join(tmp(), 'nothing'), killPid: (pid, signal) => sig.push([pid, signal]) });
    touchCert(s.ms);
    fs.writeFileSync(s.ms.paths.pidFile, pidText);
    await startWith(s);
    assert.deepStrictEqual(sig, [], pidText);
    await s.ms.stop();
  }
});

test('leftover process: on Linux the /proc way is still used and ps is not asked', async () => {
  const base = newServer({});
  let asked = 0;
  const s = newServer({ home: base.home, runtimeDir: base.runtimeDir, platform: 'linux', psCommand: () => { asked++; return null; }, procRoot: tmp() });
  touchCert(s.ms);
  fs.writeFileSync(s.ms.paths.pidFile, '903\n');
  await startWith(s);
  assert.strictEqual(asked, 0);
  await s.ms.stop();
});

test('psCommandOf: `ps -p <pid> -o command=` gives a running process\'s command line, and null for a pid that does not exist', () => {
  if (process.platform === 'win32') return;
  const line = psCommandOf(process.pid);
  assert.ok(typeof line === 'string' && line.length > 0);
  assert.ok(/node/i.test(line));
  assert.strictEqual(psCommandOf(2147483000), null);
});
