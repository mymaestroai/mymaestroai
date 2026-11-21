'use strict';
// Reversible character pack removal: lib/faces/packs removePack + `mymaestro face remove` (scripts/hub-cli.js).
// Synthetic homes under the OS temp folder only; root is simulated by injection, never real.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// lib/ and scripts/ come from a throwaway install, so nothing under the real data/ is touched.
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('face-remove-iso-', { copy: ['scripts'] });
const L = (p) => require(path.join(ISO.lib, p));
const packs = L('faces/packs');

const CLI = path.join(ISO.inst, 'scripts', 'hub-cli.js');
const mp4 = () => { const b = Buffer.alloc(88); b.writeUInt32BE(24, 0); b.write('ftypisom', 4, 'latin1'); return b; };
function makeSource(dir) {
  fs.mkdirSync(path.join(dir, 'web'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: 3, name: 'Bird', clips: [{ name: 'idle-one', state: 'idle', weight: 1, dur: 2, track: false, rare: false }] }));
  fs.writeFileSync(path.join(dir, 'web', 'idle-one.mp4'), mp4());
}
/** A synthetic hub home with one installed pack "bird". */
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'face-rm-'));
  const src = path.join(root, 'src'); fs.mkdirSync(src); makeSource(src);
  const home = path.join(root, 'home');
  packs.clearCache();
  packs.installPack(src, { home, id: 'bird' });
  return { root, src, home };
}
const NOW = new Date('2026-11-13T17:38:00.123Z');

test('remove renames the folder into faces-removed (0700), keeps every file, and gives a restore command', () => {
  const { home } = setup();
  const r = packs.removePack('bird', { home, now: NOW });
  assert.strictEqual(r.to, path.join(home, 'faces-removed', 'bird-20261113T173800123Z'));
  assert.strictEqual(fs.existsSync(path.join(home, 'faces', 'bird')), false);
  assert.ok(fs.existsSync(path.join(r.to, 'manifest.json')) && fs.existsSync(path.join(r.to, 'web', 'idle-one.mp4')));
  assert.strictEqual(fs.statSync(path.join(home, 'faces-removed')).mode & 0o777, 0o700);
  assert.strictEqual(r.restore, `mymaestro face install ${r.to} --id bird`);
  assert.deepStrictEqual(packs.listPacks({ home }), []);   // the archive is outside faces/, never listed
});

test('round trip: the printed install command restores the pack from the archive', () => {
  const { home } = setup();
  const r = packs.removePack('bird', { home, now: NOW });
  const back = packs.installPack(r.to, { home, id: 'bird' });
  assert.strictEqual(back.dir, path.join(home, 'faces', 'bird'));
  assert.deepStrictEqual(packs.listPacks({ home }).map(p => p.id), ['bird']);
  assert.ok(fs.existsSync(r.to), 'the archive stays');
});

test('a cached pack, list and the verified open all see the removal at once, with no restart', () => {
  const { home } = setup();
  const pack = packs.getPack('bird', { home });
  const f = pack.files['web/idle-one.mp4'];
  const o = packs.openVerified(pack, f); assert.ok(o); fs.closeSync(o.fd);
  assert.deepStrictEqual(packs.listPacks({ home }).map(p => p.id), ['bird']);
  packs.removePack('bird', { home, now: NOW });
  assert.strictEqual(packs.getPack('bird', { home }), null);
  assert.deepStrictEqual(packs.listPacks({ home }), []);
  assert.strictEqual(packs.openVerified(pack, f), null);   // what the file route would 404 on
});

test('a taken archive name is never overwritten', () => {
  const { home, src } = setup();
  const a = packs.removePack('bird', { home, now: NOW });
  packs.installPack(src, { home, id: 'bird' });
  const b = packs.removePack('bird', { home, now: NOW });
  assert.notStrictEqual(a.to, b.to);
  assert.strictEqual(b.to, `${a.to}-1`);
  assert.ok(fs.existsSync(path.join(a.to, 'manifest.json')) && fs.existsSync(path.join(b.to, 'manifest.json')));
  // an empty pre-existing folder of that name is not replaced either
  packs.installPack(src, { home, id: 'bird' });
  fs.mkdirSync(`${a.to}-2`);
  const c = packs.removePack('bird', { home, now: NOW });
  assert.strictEqual(c.to, `${a.to}-3`);
  assert.deepStrictEqual(fs.readdirSync(`${a.to}-2`), []);
});

test('bad ids and unknown packs are refused without changes', () => {
  const { home } = setup();
  for (const id of ['../bird', 'Bird', 'a/b', '', '-x', 'con', undefined, 'bird/..']) assert.throws(() => packs.removePack(id, { home }), /pack id|installed/, String(id));
  assert.throws(() => packs.removePack('nobody', { home }), /No character pack "nobody"/);
  assert.throws(() => packs.removePack('bird', {}), /No hub home/);
  assert.ok(fs.existsSync(path.join(home, 'faces', 'bird', 'manifest.json')));
  assert.strictEqual(fs.existsSync(path.join(home, 'faces-removed')), false);
});

test('symlinks are refused and never followed: the pack, faces/ and faces-removed/', () => {
  let s = setup();
  const target = path.join(s.root, 'elsewhere'); fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(s.home, 'faces', 'linked'));
  assert.throws(() => packs.removePack('linked', { home: s.home }), /link or not a folder/);
  assert.ok(fs.lstatSync(path.join(s.home, 'faces', 'linked')).isSymbolicLink());

  s = setup();
  fs.symlinkSync(target, path.join(s.home, 'faces-removed'));
  assert.throws(() => packs.removePack('bird', { home: s.home }), /normal folder/);
  assert.deepStrictEqual(fs.readdirSync(target), []);
  assert.ok(fs.existsSync(path.join(s.home, 'faces', 'bird')));

  s = setup();
  const real = path.join(s.home, 'faces-real'); fs.renameSync(path.join(s.home, 'faces'), real);
  fs.symlinkSync(real, path.join(s.home, 'faces'));
  assert.throws(() => packs.removePack('bird', { home: s.home }), /normal folder/);
  assert.ok(fs.existsSync(path.join(real, 'bird')));
});

test('root guard: root in a home owned by another account is refused, naming the account; no chown, no change', () => {
  const { home } = setup();
  const root = () => 0;
  // homeUid is always injected for the differing-owner cases, so this holds whatever uid the test runner has (even 0)
  assert.throws(() => packs.removePack('bird', { home, geteuid: root, getuid: () => 1000, homeUid: 1000, lookupUser: () => 'alice' }), /Refusing to run as root.*"alice"/);
  assert.throws(() => packs.removePack('bird', { home, geteuid: () => 1000, getuid: root, homeUid: 1000, lookupUser: () => 'alice' }), /"alice"/);
  assert.throws(() => packs.installPack(path.join(home, 'faces', 'bird'), { home, id: 'bird2', geteuid: root, homeUid: 1000, lookupUser: () => 'alice' }), /Run this command as "alice"/);
  assert.throws(() => packs.removePack('bird', { home, geteuid: root, getuid: root, homeUid: 4242, lookupUser: () => null }), /user id 4242/);
  assert.ok(fs.existsSync(path.join(home, 'faces', 'bird')));
  assert.strictEqual(fs.existsSync(path.join(home, 'faces', 'bird2')), false);
  // root-owned home is allowed; a non-root caller is never blocked
  assert.ok(packs.removePack('bird', { home, now: NOW, geteuid: root, getuid: root, homeUid: 0, dryRun: true }));
  assert.ok(packs.removePack('bird', { home, now: NOW, geteuid: () => 1000, getuid: () => 1000, homeUid: 0 }));
});

test('root guard: only a really absent home is allowed; any other stat error refuses clearly', () => {
  const { root, src, home } = setup();
  const asRoot = { geteuid: () => 0, getuid: () => 0 };
  // a home path that goes through a regular file: stat fails with ENOTDIR, which is not "absent"
  const file = path.join(root, 'afile'); fs.writeFileSync(file, 'x');
  const odd = path.join(file, 'home');
  assert.throws(() => packs.installPack(src, { home: odd, id: 'bird', ...asRoot }), /Refusing to run as root.*could not check.*ENOTDIR.*Nothing was changed/);
  assert.throws(() => packs.removePack('bird', { home: odd, ...asRoot }), /Refusing to run as root.*could not check.*ENOTDIR/);
  assert.strictEqual(fs.statSync(file).isFile(), true);
  // a genuinely absent home (ENOENT) is allowed: root would own what it creates
  const fresh = path.join(root, 'fresh-home');
  const r = packs.installPack(src, { home: fresh, id: 'bird2', ...asRoot });
  assert.strictEqual(r.dir, path.join(fresh, 'faces', 'bird2'));
  assert.ok(fs.existsSync(path.join(fresh, 'faces', 'bird2', 'manifest.json')));
  assert.ok(fs.existsSync(path.join(home, 'faces', 'bird')));
});

test('an existing faces-removed that is not mode 0700 is refused, untouched, and nothing is moved', () => {
  for (const mode of [0o755, 0o750, 0o777, 0o500]) {
    const { home } = setup();
    const arch = path.join(home, 'faces-removed');
    fs.mkdirSync(arch); fs.chmodSync(arch, mode);
    assert.throws(() => packs.removePack('bird', { home, now: NOW }), /must have mode 0700/, mode.toString(8));
    assert.throws(() => packs.removePack('bird', { home, now: NOW, dryRun: true }), /must have mode 0700/, `dry ${mode.toString(8)}`);
    assert.strictEqual(fs.statSync(arch).mode & 0o777, mode, 'permissions are not changed');
    assert.deepStrictEqual(fs.readdirSync(arch), []);
    assert.ok(fs.existsSync(path.join(home, 'faces', 'bird', 'manifest.json')));
    fs.chmodSync(arch, 0o700);   // an owner-fixed 0700 folder works
    assert.ok(packs.removePack('bird', { home, now: NOW }));
  }
});

test('faces routes: asset and list answer, then 404 and an empty list right after removal, with no restart', async () => {
  const routes = L('faces/routes');
  const { Readable, Writable } = require('node:stream');
  const call = async (home, pathname) => {
    const chunks = [];
    const res = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers || {}; };
    const finished = new Promise((resolve) => res.on('finish', resolve));
    const req = Object.assign(Readable.from([]), { method: 'GET', headers: {}, hubUser: { id: 'u_sam', role: 'member', name: 'Sam' } });
    await routes.handle(pathname, req, res, { home });
    if (!res.writableEnded) await finished;
    return { status: res.statusCode, body: Buffer.concat(chunks) };
  };
  const { home } = setup();
  const asset = '/api/faces/bird/web/idle-one.mp4';
  let r = await call(home, asset);
  assert.strictEqual(r.status, 200); assert.ok(r.body.equals(mp4()));
  assert.strictEqual((await call(home, '/api/faces/bird/manifest.json')).status, 200);
  r = await call(home, '/api/faces');
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(JSON.parse(r.body.toString()).packs.map(p => p.id), ['bird']);

  packs.removePack('bird', { home, now: NOW });   // same process, same cache, no clearCache and no restart

  assert.strictEqual((await call(home, asset)).status, 404);
  assert.strictEqual((await call(home, '/api/faces/bird/manifest.json')).status, 404);
  r = await call(home, '/api/faces');
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(JSON.parse(r.body.toString()).packs, []);

  // removed by another process (this cache is not told): the routes still stop serving at once
  const s2 = setup();
  assert.strictEqual((await call(s2.home, asset)).status, 200);
  fs.mkdirSync(path.join(s2.home, 'elsewhere'));
  fs.renameSync(path.join(s2.home, 'faces', 'bird'), path.join(s2.home, 'elsewhere', 'bird'));
  assert.strictEqual((await call(s2.home, asset)).status, 404);
  assert.deepStrictEqual(JSON.parse((await call(s2.home, '/api/faces')).body.toString()).packs, []);
});

test('first-ever archive mkdir: EEXIST from another process is tolerated only when the folder is secure', () => {
  const realMkdir = fs.mkdirSync;
  const raced = (home, make) => {
    const arch = path.join(home, 'faces-removed');
    fs.mkdirSync = function (p, ...rest) {
      if (p === arch) { fs.mkdirSync = realMkdir; make(arch); const e = new Error('EEXIST: file already exists'); e.code = 'EEXIST'; throw e; }
      return realMkdir.call(fs, p, ...rest);
    };
  };
  try {
    // the other process made a secure folder: carry on and archive into it
    let s = setup();
    raced(s.home, (a) => { realMkdir(a, { mode: 0o700 }); fs.chmodSync(a, 0o700); });
    const r = packs.removePack('bird', { home: s.home, now: NOW });
    assert.strictEqual(fs.mkdirSync, realMkdir);
    assert.ok(fs.existsSync(path.join(r.to, 'manifest.json')));
    assert.strictEqual(fs.existsSync(path.join(s.home, 'faces', 'bird')), false);

    // the other process made an insecure folder: refused, nothing moved, permissions untouched
    s = setup();
    raced(s.home, (a) => { realMkdir(a); fs.chmodSync(a, 0o755); });
    assert.throws(() => packs.removePack('bird', { home: s.home, now: NOW }), /changed or is not mode 0700/);
    assert.ok(fs.existsSync(path.join(s.home, 'faces', 'bird', 'manifest.json')));
    assert.strictEqual(fs.statSync(path.join(s.home, 'faces-removed')).mode & 0o777, 0o755);
    assert.deepStrictEqual(fs.readdirSync(path.join(s.home, 'faces-removed')), []);

    // the other process made a symlink: refused, never followed
    s = setup();
    const target = path.join(s.root, 'elsewhere'); realMkdir(target);
    raced(s.home, (a) => fs.symlinkSync(target, a));
    assert.throws(() => packs.removePack('bird', { home: s.home, now: NOW }), /changed or is not mode 0700/);
    assert.deepStrictEqual(fs.readdirSync(target), []);
    assert.ok(fs.existsSync(path.join(s.home, 'faces', 'bird')));

    // any other mkdir error is still an error
    s = setup();
    fs.mkdirSync = function (p, ...rest) {
      if (p === path.join(s.home, 'faces-removed')) { fs.mkdirSync = realMkdir; const e = new Error('EACCES'); e.code = 'EACCES'; throw e; }
      return realMkdir.call(fs, p, ...rest);
    };
    assert.throws(() => packs.removePack('bird', { home: s.home, now: NOW }), /EACCES/);
    assert.ok(fs.existsSync(path.join(s.home, 'faces', 'bird')));
  } finally { fs.mkdirSync = realMkdir; }
});

test('Windows: remove refuses plainly before any change', () => {
  const { home } = setup();
  for (const dryRun of [false, true]) {
    assert.throws(() => packs.removePack('bird', { home, now: NOW, dryRun, platform: 'win32' }), /not supported on Windows; nothing was changed/);
  }
  assert.ok(fs.existsSync(path.join(home, 'faces', 'bird', 'manifest.json')));
  assert.strictEqual(fs.existsSync(path.join(home, 'faces-removed')), false);
  assert.ok(packs.getPack('bird', { home }));
});

test('two processes: a cached pack, list and verified open stop at once after ANOTHER process renames the folder', () => {
  const { home } = setup();
  const pack = packs.getPack('bird', { home });
  const f = pack.files['web/idle-one.mp4'];
  const o = packs.openVerified(pack, f); assert.ok(o); fs.closeSync(o.fd);
  assert.deepStrictEqual(packs.listPacks({ home }).map(p => p.id), ['bird']);
  const other = (from, to) => spawnSync(process.execPath, ['-e', 'require("fs").renameSync(process.argv[1], process.argv[2])', from, to], { encoding: 'utf8', timeout: 30000 });
  const live = path.join(home, 'faces', 'bird'), away = path.join(home, 'bird-away');
  let r = other(live, away);
  assert.strictEqual(r.status, 0, r.stderr);
  // no clearCache, no restart, same process cache
  assert.strictEqual(packs.openVerified(pack, f), null);
  assert.strictEqual(packs.getPack('bird', { home }), null);
  assert.deepStrictEqual(packs.listPacks({ home }), []);
  // the other process puts it back: it is found again by a fresh validation
  r = other(away, live);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(packs.listPacks({ home }).map(p => p.id), ['bird']);
  assert.ok(packs.getPack('bird', { home }));
});

test('dryRun changes nothing', () => {
  const { home } = setup();
  const r = packs.removePack('bird', { home, now: NOW, dryRun: true });
  assert.match(r.to, /faces-removed\/bird-20261113T173800123Z$/);
  assert.ok(fs.existsSync(path.join(home, 'faces', 'bird')));
  assert.strictEqual(fs.existsSync(path.join(home, 'faces-removed')), false);
});

// ── the command ──
function cli(home, args, input) {
  return spawnSync(process.execPath, [CLI, 'face', ...args], { env: { PATH: process.env.PATH, HOME: home, HUB_HOME: home }, input, encoding: 'utf8', timeout: 30000 });
}

test('face remove: without --yes it asks; n or closed input changes nothing', () => {
  const { home } = setup();
  let r = cli(home, ['remove', 'bird'], 'n\n');
  assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /Nothing was changed/); assert.match(r.stdout, /faces-removed/);
  assert.ok(fs.existsSync(path.join(home, 'faces', 'bird')));
  r = cli(home, ['remove', 'bird'], '');
  assert.notStrictEqual(r.status, 0);
  assert.ok(fs.existsSync(path.join(home, 'faces', 'bird')));
  r = cli(home, ['remove', 'bird'], 'y\n');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /To bring it back:\s+mymaestro face install \S*faces-removed\/bird-\S+ --id bird/);
  assert.strictEqual(fs.existsSync(path.join(home, 'faces', 'bird')), false);
});

test('face remove --yes skips the question; list no longer shows it; unknown or bad ids fail', () => {
  const { home } = setup();
  assert.match(cli(home, ['list']).stdout, /^bird /);
  const r = cli(home, ['remove', 'bird', '--yes']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(cli(home, ['list']).stdout, /No character packs are installed/);
  assert.notStrictEqual(cli(home, ['remove', 'bird', '--yes']).status, 0);
  assert.match(cli(home, ['remove', '../x', '--yes']).stderr, /pack id/);
  assert.match(cli(home, ['remove']).stderr, /Usage/);
});
