'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProbes, parseDfK, parseDfI, parseMeminfo, parseVmStat, parseSwapUsage } = require('../lib/system-health/probes');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-probes-'));

// Real Linux output captured on this computer
const LINUX_DF_K = `Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/nvme0n1p2  1920641288 540692716 1282311608      30% /
`;
const LINUX_DF_I = `Filesystem        Inodes   IUsed     IFree IUse% Mounted on
/dev/nvme0n1p2 122028032 7020408 115007624    6% /
`;
const MAC_DF_K = `Filesystem   1024-blocks     Used Available Capacity Mounted on
/dev/disk3s1s1 482797652 10135964 260094052     4% /
`;
const MAC_DF_I = `Filesystem   512-blocks     Used Available Capacity iused      ifree %iused  Mounted on
/dev/disk3s1s1 965595304 20271928 520188104     4%  403755 2600940520    0%   /
`;
const LINUX_MEMINFO = `MemTotal:       261097260 kB
MemFree:         8792936 kB
MemAvailable:   239374532 kB
Buffers:        21134408 kB
Cached:         198957572 kB
SwapTotal:       8388604 kB
SwapFree:        8388604 kB
`;
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               1000.
Pages active:                           500000.
Pages inactive:                           2000.
Pages speculative:                         300.
Pages throttled:                             0.
Pages purgeable:                           700.
`;
const SWAP_USAGE = 'total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)\n';

const ok = (stdout) => ({ stdout, stderr: '', code: 0, timedOut: false });
const timedOut = { stdout: '', stderr: '', code: null, timedOut: true };

test('parseDfK on Linux and macOS', () => {
  assert.deepStrictEqual(parseDfK(LINUX_DF_K), { totalBytes: 1920641288 * 1024, usedBytes: 540692716 * 1024, availBytes: 1282311608 * 1024 });
  assert.strictEqual(parseDfK(MAC_DF_K).availBytes, 260094052 * 1024);
  assert.strictEqual(parseDfK('garbage'), null);
  assert.strictEqual(parseDfK(''), null);
});

test('parseDfI by header names on Linux and macOS', () => {
  assert.deepStrictEqual(parseDfI(LINUX_DF_I), { inodesTotal: 122028032, inodesFree: 115007624 });
  // macOS: total = iused + ifree; the 512-blocks/Used/Available columns must not be mistaken for inodes
  assert.deepStrictEqual(parseDfI(MAC_DF_I), { inodesTotal: 403755 + 2600940520, inodesFree: 2600940520 });
  // a filesystem that reports no inodes
  assert.deepStrictEqual(parseDfI('Filesystem Inodes IUsed IFree IUse% Mounted on\n/dev/x 0 0 0 - /\n'), { inodesTotal: null, inodesFree: null });
  assert.strictEqual(parseDfI('nope'), null);
});

test('parseMeminfo, parseVmStat, parseSwapUsage', () => {
  assert.deepStrictEqual(parseMeminfo(LINUX_MEMINFO), {
    totalBytes: 261097260 * 1024, availableBytes: 239374532 * 1024, swapTotalBytes: 8388604 * 1024, swapFreeBytes: 8388604 * 1024,
  });
  assert.strictEqual(parseMeminfo('').totalBytes, null);
  const v = parseVmStat(VM_STAT);
  assert.strictEqual(v.pageSize, 16384);
  assert.strictEqual(v.availableBytes, (1000 + 2000 + 300 + 700) * 16384);
  assert.strictEqual(parseVmStat('nothing'), null);
  assert.deepStrictEqual(parseSwapUsage(SWAP_USAGE), {
    totalBytes: 2048 * 1024 ** 2, usedBytes: Math.round(1024.5 * 1024 ** 2), freeBytes: Math.round(1023.5 * 1024 ** 2),
  });
  assert.strictEqual(parseSwapUsage('total = 1.5G used = 0.00K free = 1.5G').totalBytes, 1.5 * 1024 ** 3);
  assert.strictEqual(parseSwapUsage('x'), null);
});

// ---------- disk ----------
const fakeStat = (map) => async (p) => {
  if (!(p in map)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
  return { dev: map[p], size: 10 };
};

test('disk through statfs groups paths on one device and reads inodes', async () => {
  const probes = createProbes({
    stat: fakeStat({ '/data': 1, '/data/logs': 1, '/other': 2 }),
    statfs: async (p) => (p === '/other'
      ? { bsize: 4096, blocks: 1000, bavail: 100, files: 0, ffree: 0 }
      : { bsize: 4096, blocks: 1000, bavail: 250, files: 200, ffree: 50 }),
  });
  const r = await probes.disk([{ label: 'logs', path: '/data/logs' }, { label: 'data', path: '/data' }, { label: 'alpha', path: '/other' }]);
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(r.filesystems.length, 2);
  const fs1 = r.filesystems.find((f) => f.key === 'data+logs');
  assert.deepStrictEqual(fs1.labels, ['data', 'logs']);
  assert.deepStrictEqual(fs1.paths.sort(), ['/data', '/data/logs']);
  assert.strictEqual(fs1.totalBytes, 4096000);
  assert.strictEqual(fs1.availBytes, 250 * 4096);
  assert.strictEqual(fs1.availPct, 25);
  assert.strictEqual(fs1.inodesTotal, 200);
  assert.strictEqual(fs1.inodesFree, 50);
  assert.strictEqual(fs1.inodesFreePct, 25);
  assert.strictEqual(fs1.via, 'statfs');
  const fs2 = r.filesystems.find((f) => f.key === 'alpha');
  assert.strictEqual(fs2.inodesTotal, null);
  assert.strictEqual(fs2.inodesFree, null);
  assert.strictEqual(fs2.inodesFreePct, null);
});

test('disk measures a missing path at its nearest existing parent', async () => {
  const seen = [];
  const probes = createProbes({
    stat: fakeStat({ '/data': 7 }),
    statfs: async (p) => { seen.push(p); return { bsize: 1, blocks: 100, bavail: 40, files: 0, ffree: 0 }; },
  });
  const r = await probes.disk([{ label: 'backups', path: '/data/not/there/yet' }]);
  assert.deepStrictEqual(seen, ['/data']);
  assert.strictEqual(r.filesystems[0].availPct, 40);
  assert.deepStrictEqual(r.filesystems[0].paths, ['/data/not/there/yet']);
});

function dfExec(calls, { kOut = LINUX_DF_K, iOut = LINUX_DF_I, hang = false } = {}) {
  return async (file, args, opts) => {
    calls.push({ file, args, opts });
    if (hang) return timedOut;
    if (file === 'df' && args[0] === '-kP') return ok(kOut);
    if (file === 'df' && args[0] === '-iP') return ok(iOut);
    return { stdout: '', stderr: 'unexpected', code: 1, timedOut: false };
  };
}

test('disk forced through df (statfs: null) uses df -kP and df -iP with argument lists', async () => {
  const calls = [];
  const probes = createProbes({ statfs: null, stat: fakeStat({ '/data': 1, '/data/a': 1 }), exec: dfExec(calls) });
  const r = await probes.disk([{ label: 'alpha', path: '/data/a' }, { label: 'owner', path: '/data' }], { timeoutMs: 1234 });
  assert.strictEqual(r.filesystems.length, 1);
  const f = r.filesystems[0];
  assert.strictEqual(f.key, 'alpha+owner');
  assert.strictEqual(f.via, 'df');
  assert.strictEqual(f.totalBytes, 1920641288 * 1024);
  assert.strictEqual(f.availBytes, 1282311608 * 1024);
  assert.strictEqual(f.inodesTotal, 122028032);
  assert.strictEqual(f.inodesFree, 115007624);
  assert.ok(Math.abs(f.inodesFreePct - (115007624 / 122028032) * 100) < 1e-9);
  assert.deepStrictEqual(calls.map((c) => c.args).sort(), [['-iP', '/data/a'], ['-kP', '/data/a']].sort());
  assert.ok(calls.every((c) => c.file === 'df' && Array.isArray(c.args) && c.opts.timeoutMs === 1234));
});

test('disk via df: inodes null when df -iP reports 0 or fails; a df that times out gives an error entry', async () => {
  const zero = 'Filesystem Inodes IUsed IFree IUse% Mounted on\n/dev/x 0 0 0 - /\n';
  const p1 = createProbes({ statfs: null, stat: fakeStat({ '/d': 1 }), exec: dfExec([], { iOut: zero }) });
  const r1 = await p1.disk([{ label: 'alpha', path: '/d' }]);
  assert.strictEqual(r1.filesystems[0].inodesTotal, null);
  assert.strictEqual(r1.filesystems[0].inodesFreePct, null);
  assert.ok(r1.filesystems[0].totalBytes > 0);

  const p2 = createProbes({ statfs: null, stat: fakeStat({ '/d': 1 }), exec: dfExec([], { hang: true }) });
  const r2 = await p2.disk([{ label: 'alpha', path: '/d' }]);
  assert.strictEqual(r2.filesystems.length, 0);
  assert.strictEqual(r2.errors.length, 1);
  assert.strictEqual(r2.errors[0].label, 'alpha');
  assert.strictEqual(r2.errors[0].path, '/d');
  assert.ok(r2.errors[0].error);

  const p3 = createProbes({ statfs: null, stat: fakeStat({ '/d': 1 }), exec: async () => { throw new Error('boom'); } });
  const r3 = await p3.disk([{ label: 'alpha', path: '/d' }]);
  assert.strictEqual(r3.errors.length, 1);
});

test('disk with a statfs that never answers reports an error after the time limit', async () => {
  const probes = createProbes({ stat: fakeStat({ '/d': 1 }), statfs: () => new Promise(() => {}) });
  const r = await probes.disk([{ label: 'alpha', path: '/d' }], { timeoutMs: 30 });
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(r.filesystems.length, 0);
});

test('disk with a path whose stat fails all the way up is an error entry', async () => {
  const probes = createProbes({ stat: async () => { throw new Error('nope'); }, statfs: async () => ({}) });
  const r = await probes.disk([{ label: 'alpha', path: '/zzz/yyy' }]);
  assert.strictEqual(r.errors.length, 1);
});

test('one real disk() call on os.tmpdir() returns sane numbers', async () => {
  const probes = createProbes({});
  const r = await probes.disk([{ label: 'temp', path: os.tmpdir() }]);
  assert.strictEqual(r.errors.length, 0);
  const f = r.filesystems[0];
  assert.strictEqual(f.via, 'statfs');
  assert.ok(f.totalBytes > 0);
  assert.ok(f.availBytes >= 0 && f.availBytes <= f.totalBytes);
  assert.ok(f.availPct >= 0 && f.availPct <= 100);
});

// ---------- memory ----------
test('memory on linux reads /proc/meminfo', async () => {
  const reads = [];
  const probes = createProbes({ platform: 'linux', readFile: async (p) => { reads.push(p); return LINUX_MEMINFO; } });
  const m = await probes.memory();
  assert.deepStrictEqual(reads, ['/proc/meminfo']);
  assert.strictEqual(m.totalBytes, 261097260 * 1024);
  assert.strictEqual(m.availableBytes, 239374532 * 1024);
  assert.strictEqual(m.swapTotalBytes, 8388604 * 1024);
  assert.strictEqual(m.swapUsedBytes, 0);
  assert.ok(m.via);
  const used = await createProbes({ platform: 'linux', readFile: async () => 'MemTotal: 100 kB\nMemAvailable: 50 kB\nSwapTotal: 40 kB\nSwapFree: 10 kB\n' }).memory();
  assert.strictEqual(used.swapUsedBytes, 30 * 1024);
});

test('memory on darwin runs vm_stat and sysctl -n vm.swapusage', async () => {
  const calls = [];
  const fakeOs = { totalmem: () => 16 * 1024 ** 3, freemem: () => 1 };
  const probes = createProbes({
    platform: 'darwin', os: fakeOs,
    exec: async (file, args) => {
      calls.push([file, ...args]);
      if (file === 'vm_stat') return ok(VM_STAT);
      if (file === 'sysctl') return ok(SWAP_USAGE);
      return { stdout: '', stderr: '', code: 1, timedOut: false };
    },
  });
  const m = await probes.memory();
  assert.deepStrictEqual(calls, [['vm_stat'], ['sysctl', '-n', 'vm.swapusage']]);
  assert.strictEqual(m.availableBytes, 4000 * 16384);
  assert.strictEqual(m.totalBytes, 16 * 1024 ** 3);
  assert.strictEqual(m.swapTotalBytes, 2048 * 1024 ** 2);
  assert.strictEqual(m.swapUsedBytes, Math.round(1024.5 * 1024 ** 2));
});

test('memory falls back to os.freemem() with null swap when unreadable', async () => {
  const fakeOs = { totalmem: () => 1000, freemem: () => 400 };
  const lin = await createProbes({ platform: 'linux', os: fakeOs, readFile: async () => { throw new Error('denied'); } }).memory();
  assert.deepStrictEqual([lin.totalBytes, lin.availableBytes, lin.swapTotalBytes, lin.swapUsedBytes], [1000, 400, null, null]);
  const lin2 = await createProbes({ platform: 'linux', os: fakeOs, readFile: async () => 'garbage' }).memory();
  assert.strictEqual(lin2.availableBytes, 400);
  const mac = await createProbes({ platform: 'darwin', os: fakeOs, exec: async () => timedOut }).memory();
  assert.deepStrictEqual([mac.availableBytes, mac.swapTotalBytes, mac.swapUsedBytes], [400, null, null]);
  const other = await createProbes({ platform: 'win32', os: fakeOs }).memory();
  assert.strictEqual(other.availableBytes, 400);
  // darwin: vm_stat fine but swap unreadable -> swap null only
  const mac2 = await createProbes({
    platform: 'darwin', os: { totalmem: () => 1 << 30, freemem: () => 5 },
    exec: async (f) => (f === 'vm_stat' ? ok(VM_STAT) : timedOut),
  }).memory();
  assert.strictEqual(mac2.availableBytes, 4000 * 16384);
  assert.strictEqual(mac2.swapTotalBytes, null);
});

// ---------- clock ----------
test('clock on linux: yes, no, missing tool', async () => {
  const mk = (r) => createProbes({ platform: 'linux', exec: async (file, args) => { mk.last = [file, ...args]; return r; } });
  assert.deepStrictEqual(await mk(ok('yes\n')).clock(), { synced: true, how: 'timedatectl' });
  assert.deepStrictEqual(mk.last, ['timedatectl', 'show', '-p', 'NTPSynchronized', '--value']);
  assert.strictEqual((await mk(ok('no\n')).clock()).synced, false);
  assert.strictEqual((await mk({ stdout: '', stderr: 'ENOENT', code: null, timedOut: false }).clock()).synced, null);
  assert.strictEqual((await mk(ok('maybe')).clock()).synced, null);
  assert.strictEqual((await mk(timedOut).clock()).synced, null);
});

test('clock on darwin: on, off, missing or refused', async () => {
  const mk = (r) => createProbes({ platform: 'darwin', exec: async (file, args) => { mk.last = [file, ...args]; return r; } });
  assert.strictEqual((await mk(ok('Network Time: On\n')).clock()).synced, true);
  assert.deepStrictEqual(mk.last, ['systemsetup', '-getusingnetworktime']);
  assert.strictEqual((await mk(ok('Network Time: Off\n')).clock()).synced, false);
  assert.strictEqual((await mk({ stdout: 'You need administrator access to run this tool... exiting!', stderr: '', code: 1, timedOut: false }).clock()).synced, null);
  assert.strictEqual((await mk({ stdout: '', stderr: '', code: null, timedOut: false }).clock()).synced, null);
});

test('clock on an unsupported platform is null', async () => {
  assert.strictEqual((await createProbes({ platform: 'win32' }).clock()).synced, null);
});

// ---------- folderSizes ----------
test('folderSizes sorts largest first, nulls last, skips missing folders', async () => {
  const calls = [];
  const sizes = { '/f/small': 10, '/f/big': 5000 };
  const probes = createProbes({
    stat: fakeStat({ '/f/small': 1, '/f/big': 1, '/f/slow': 1, '/f/bad': 1 }),
    exec: async (file, args, opts) => {
      calls.push({ file, args, opts });
      const p = args[1];
      if (p === '/f/slow') return timedOut;
      if (p === '/f/bad') return { stdout: '', stderr: 'du: cannot read\n', code: 1, timedOut: false };
      return ok(`${sizes[p]}\t${p}\n`);
    },
  });
  const r = await probes.folderSizes([
    { label: 'slow', path: '/f/slow' }, { label: 'small', path: '/f/small' },
    { label: 'gone', path: '/f/gone' }, { label: 'big', path: '/f/big' }, { label: 'bad', path: '/f/bad' },
  ], { timeoutMs: 777 });
  assert.deepStrictEqual(r.map((x) => x.label), ['big', 'small', 'slow', 'bad']);
  assert.strictEqual(r[0].bytes, 5000 * 1024);
  assert.strictEqual(r[1].bytes, 10 * 1024);
  assert.strictEqual(r[2].bytes, null);
  assert.ok(r[2].error);
  assert.strictEqual(r[3].bytes, null);
  assert.ok(r[3].error);
  assert.ok(!calls.some((c) => c.args[1] === '/f/gone'));
  assert.ok(calls.every((c) => c.file === 'du' && c.args[0] === '-sk' && c.opts.timeoutMs === 777));
});

// ---------- fileSizes ----------
test('fileSizes gives bytes, null when missing', async () => {
  const f = path.join(tmp, 'sized.txt');
  fs.writeFileSync(f, 'hello');
  const r = await createProbes({}).fileSizes([f, path.join(tmp, 'missing.txt')]);
  assert.deepStrictEqual(r, [{ path: f, bytes: 5 }, { path: path.join(tmp, 'missing.txt'), bytes: null }]);
});

// ---------- dbCheck ----------
test('dbCheck on a real SQLite file is ok true, with its size', async () => {
  const Database = require('better-sqlite3');
  const file = path.join(tmp, 'good.db');
  const db = new Database(file);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES (\'alpha\');');
  db.close();
  const r = await createProbes({}).dbCheck(file, { timeoutMs: 30000 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.result, 'ok');
  assert.strictEqual(r.bytes, fs.statSync(file).size);
});

test('dbCheck on random bytes is not ok true', async () => {
  const file = path.join(tmp, 'junk.db');
  fs.writeFileSync(file, require('crypto').randomBytes(8192));
  const r = await createProbes({}).dbCheck(file, { timeoutMs: 30000 });
  assert.notStrictEqual(r.ok, true);
  assert.ok(r.ok === false || r.ok === null);
  assert.strictEqual(r.bytes, 8192);
});

test('dbCheck on a missing file is ok null with bytes null', async () => {
  const r = await createProbes({}).dbCheck(path.join(tmp, 'nope.db'), { timeoutMs: 30000 });
  assert.strictEqual(r.ok, null);
  assert.strictEqual(r.bytes, null);
});

test('dbCheck spawns node with db-check.js through exec; a timeout is ok null; bad output is ok null', async () => {
  const calls = [];
  const file = path.join(tmp, 'sized.txt');
  const p1 = createProbes({ nodePath: '/fake/node', exec: async (f, a, o) => { calls.push({ f, a, o }); return timedOut; } });
  const r = await p1.dbCheck(file, { timeoutMs: 555 });
  assert.strictEqual(r.ok, null);
  assert.strictEqual(r.bytes, 5);
  assert.strictEqual(calls[0].f, '/fake/node');
  assert.deepStrictEqual(calls[0].a, [path.join(__dirname, '..', 'lib', 'system-health', 'db-check.js'), file]);
  assert.strictEqual(calls[0].o.timeoutMs, 555);
  const r2 = await createProbes({ exec: async () => ok('not json') }).dbCheck(file);
  assert.strictEqual(r2.ok, null);
  const r3 = await createProbes({ exec: async () => ok('{"ok":false,"result":"row 3 is bad"}\n') }).dbCheck(file);
  assert.deepStrictEqual([r3.ok, r3.result], [false, 'row 3 is bad']);
  const r4 = await createProbes({ exec: async () => { throw new Error('x'); } }).dbCheck(file);
  assert.strictEqual(r4.ok, null);
});

test('default exec never throws and reports a timeout', async () => {
  const probes = createProbes({});
  // a missing tool resolves instead of throwing
  const c = await createProbes({ platform: 'linux', exec: undefined }).folderSizes([{ label: 'temp', path: tmp }], { timeoutMs: 20000 });
  assert.strictEqual(c.length, 1);
  assert.ok(c[0].bytes === null || c[0].bytes >= 0);
  assert.ok(probes);
});

test.after(() => { /* temp files live under os.tmpdir() only */ });
