'use strict';
// R5-2 / R5-3 / FU-6: one journal for everything and one resolver for the account folder (lib/auth resolveAuthDir).
// With HUB_AUTH_DIR pointing outside the install's data/ (absolute or relative to the current folder), a preference change, an outside
// edit of a file in the account folder and a failed commit all go to the install's data/settings-journal.jsonl, which history, Restore and
// reconcile read. The same folder by two paths is watched once. Runs on a throwaway install copy.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeIsolatedInstall } = require('./helpers/isolated-install');

const inst = makeIsolatedInstall('sj-ad-', { copy: ['templates/settings-records.json', 'scripts'] });
const L = (m) => require(path.join(inst.lib, m));
const journal = L('settings-journal');
const authMod = L('auth');
const INSTALL_JOURNAL = path.join(inst.data, 'settings-journal.jsonl');
const lines = (f = INSTALL_JOURNAL) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const rawWrite = (file, text) => { const fd = fs.openSync(file, 'w'); try { fs.writeSync(fd, text); } finally { fs.closeSync(fd); } };
const real = (p) => fs.realpathSync(p);
const fakeTimers = () => ({ setTimeout: (fn, ms) => ({ fn, ms, unref() {} }), clearTimeout() {} });

// A fresh account folder outside the install; HUB_AUTH_DIR names it as `spell(dir)` says (absolute, or relative to the current folder).
function withAuthDir(spell, fn) {
  const dir = fs.mkdtempSync(path.join(real(os.tmpdir()), 'sj-acct-'));
  const was = process.env.HUB_AUTH_DIR;
  process.env.HUB_AUTH_DIR = spell(dir);
  try { return fn(dir); } finally { process.env.HUB_AUTH_DIR = was; fs.rmSync(dir, { recursive: true, force: true }); }
}
const SPELLINGS = { absolute: (d) => d, relative: (d) => path.relative(process.cwd(), d) };

test('resolveAuthDir: HUB_AUTH_DIR resolved against the current folder, else the install data/; no file is read when lib/auth loads', () => {
  assert.equal(typeof authMod.resolveAuthDir, 'function');
  assert.equal(authMod.resolveAuthDir({ HUB_AUTH_DIR: '/x/y' }), path.resolve('/x/y'));
  assert.equal(authMod.resolveAuthDir({ HUB_AUTH_DIR: 'rel/acct' }), path.resolve('rel/acct'));
  assert.equal(authMod.resolveAuthDir({}), path.join(inst.inst, 'data'));
  const src = fs.readFileSync(path.join(inst.lib, 'auth.js'), 'utf8');
  const head = src.slice(0, src.indexOf('function resolveAuthDir'));
  assert.ok(!/readFileSync|existsSync|statSync|readdirSync|realpathSync/.test(head), 'nothing is read before the resolver');
  // loading lib/auth in a clean process under a spy: no file read at load
  const code = `const fs=require('fs');const seen=[];for(const n of ['readFileSync','existsSync','statSync','readdirSync','openSync','mkdirSync']){const o=fs[n];fs[n]=function(p){if(String(p).includes('settings-authdir-probe'))seen.push(n);return o.apply(this,arguments)}}
    process.env.HUB_AUTH_DIR='/tmp/settings-authdir-probe';const a=require(${JSON.stringify(path.join(inst.lib, 'auth'))});console.log(a.resolveAuthDir(),seen.length)`;
  const r = spawnSync(process.execPath, ['-e', code], { env: { PATH: process.env.PATH, HOME: os.tmpdir() }, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '/tmp/settings-authdir-probe 0', r.stderr);
});

for (const [kind, spell] of Object.entries(SPELLINGS)) {
  test(`R5-2 (${kind} HUB_AUTH_DIR): a preference change goes to the install journal and shows in history`, () => {
    withAuthDir(spell, (dir) => {
      const au = authMod.createAuth({ log: () => {} });   // the default folder: the resolver's
      const m = au.createUser({ login: `ad-${kind}@example.com`, name: 'AD', role: 'member', password: 'ad-long-password-1' }).user;
      assert.ok(fs.existsSync(path.join(dir, 'users.json')), 'the account file is in the moved folder');
      au.setPrefs(m.id, { theme: 'dark' });
      const e = journal.list({ limit: 50 }).find((x) => x.key === `prefs.${m.id}.theme`);
      assert.ok(e, 'history (list) shows it');
      assert.equal(e.after, 'dark');
      assert.ok(journal.get(e.id), 'get / Restore find it');
      assert.ok(journal.listFor({ isAdmin: true, limit: 50 }).some((x) => x.id === e.id), 'the admin view shows it');
      assert.ok(lines().some((l) => l.id === e.id), 'the line is in <install>/data/settings-journal.jsonl');
      assert.ok(!fs.existsSync(path.join(dir, 'settings-journal.jsonl')), 'no second journal in the account folder');
    });
  });

  test(`R5-2 (${kind} HUB_AUTH_DIR): an outside edit in the account folder is journaled in the install journal`, () => {
    withAuthDir(spell, (dir) => {
      journal.configure({ timers: fakeTimers(), notify: () => {} });
      rawWrite(path.join(dir, 'connectors.json'), '{"connectors":[]}');
      const w = journal.startWatch({ dataDir: authMod.resolveAuthDir(), intervalMs: 0 });
      try {
        w.tick();
        const n0 = journal.list({ limit: 500 }).filter((x) => x.store === 'files').length;
        rawWrite(path.join(dir, 'connectors.json'), '{"connectors":[{"id":"by-hand"}]}');
        w.tick();
        const files = journal.list({ limit: 500 }).filter((x) => x.store === 'files');
        assert.equal(files.length, n0 + 1, 'one outside entry, seen by history');
        assert.equal(files[0].key, 'files/connectors.json');
        assert.ok(lines().some((l) => l.id === files[0].id), 'written to the install journal');
        assert.ok(!fs.existsSync(path.join(dir, 'settings-journal.jsonl')), 'no second journal');
        // the command line's marker for the same folder goes to the install journal too and keeps its own write quiet
        const code = `const sj=require(${JSON.stringify(path.join(inst.lib, 'settings-journal'))});sj.startCliMarking({dataDir:require(${JSON.stringify(path.join(inst.lib, 'auth'))}).resolveAuthDir()});require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'connectors.json'))},'{"connectors":[{"id":"cli"}]}')`;
        const r = spawnSync(process.execPath, ['-e', code], { env: { PATH: process.env.PATH, HOME: os.tmpdir(), HUB_AUTH_DIR: process.env.HUB_AUTH_DIR }, cwd: process.cwd(), encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        assert.ok(lines().some((l) => l.marker && /connectors\.json$/.test(l.store)), 'the marker is in the install journal');
        w.tick();
        assert.equal(journal.list({ limit: 500 }).filter((x) => x.store === 'files').length, n0 + 1, 'the command line\'s own write is quiet');
      } finally { w.stop(); journal.configure({ clock: Date.now, timers: { setTimeout, clearTimeout }, notify: null }); }
    });
  });

  test(`R5-2 (${kind} HUB_AUTH_DIR): a failed users.json write and a failed commit line are handled in the install journal (history, reconcile)`, () => {
    withAuthDir(spell, (dir) => {
      const au = authMod.createAuth({ log: () => {} });
      const m = au.createUser({ login: `adf-${kind}@example.com`, name: 'ADF', role: 'member', password: 'ad-long-password-1' }).user;
      // the file write fails: the entry is marked failed in the install journal and not shown
      const users = path.join(dir, 'users.json');
      const rn = fs.renameSync, log = console.error;
      fs.renameSync = function (a, b) { if (String(b) === users) { const e = new Error('disk full (test)'); e.code = 'ENOSPC'; throw e; } return rn.apply(this, arguments); };
      console.error = () => {};
      try { assert.throws(() => au.setPrefs(m.id, { theme: 'dark' }), /disk full|could not be written/); } finally { fs.renameSync = rn; console.error = log; }
      const pend = lines().filter((l) => l.pending && l.key === `prefs.${m.id}.theme`).pop();
      assert.ok(pend, 'the pending entry is in the install journal');
      assert.ok(lines().some((l) => l.failedOf === pend.id), 'marked failed there');
      assert.equal(journal.get(pend.id), null, 'history does not show it');
      // the commit line fails: the change stays saved, the entry stays pending until reconcile
      const ap = fs.appendFileSync, warn = console.warn;
      fs.appendFileSync = function (f, text) { if (String(f) === INSTALL_JOURNAL && String(text).includes('"commitOf"')) { const e = new Error('disk full (test)'); e.code = 'ENOSPC'; throw e; } return ap.apply(this, arguments); };
      console.warn = () => {};
      try { au.setPrefs(m.id, { theme: 'light' }); } finally { fs.appendFileSync = ap; console.warn = warn; }
      assert.equal(au.getUser(m.id).theme, 'light', 'the change itself was saved');
      const p2 = lines().filter((l) => l.pending && l.key === `prefs.${m.id}.theme` && l.after === 'light').pop();
      assert.ok(p2 && !lines().some((l) => l.commitOf === p2.id), 'pending without a commit line');
      assert.equal(journal.get(p2.id), null, 'invisible until reconciled');
      const res = journal.reconcile();
      assert.ok(res.committed + res.failed >= 1, `reconcile reads the install journal: ${JSON.stringify(res)}`);
      assert.ok(!fs.existsSync(path.join(dir, 'settings-journal.jsonl')), 'no second journal');
    });
  });

  test(`R5-3 (${kind} HUB_AUTH_DIR): scripts/hub-token.js and scripts/hub-cli.js use the resolver`, () => {
    withAuthDir(spell, (dir) => {
      const env = { PATH: process.env.PATH, HOME: os.tmpdir(), HUB_AUTH_DIR: process.env.HUB_AUTH_DIR };
      const r = spawnSync(process.execPath, [path.join(inst.inst, 'scripts', 'hub-token.js'), 'create', '--name', `res-${kind}`, '--scopes', 'status'], { env, cwd: process.cwd(), encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.ok(fs.existsSync(path.join(dir, 'auth.db')), 'the token went to the resolved folder (tokens live in auth.db)');
      assert.ok(!fs.existsSync(path.join(inst.data, 'auth.db')), 'not to the install data folder');
    });
  });
}

test('R5-3: scripts/hub-cli.js builds its account store and its markers from the resolver', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'hub-cli.js'), 'utf8');
  assert.match(src, /function auth\(\) \{ const a = require\(path\.join\(DIR, 'lib', 'auth'\)\); return a\.createAuth\(\{ log: \(\) => \{\}, dataDir: a\.resolveAuthDir\(\) \}\); \}/);
  assert.match(src, /startCliMarking\(\{ dataDir: acctC \}\)/);
  assert.match(src, /const acctC = require\(path\.join\(__dirname, '\.\.', 'lib', 'auth'\)\)\.resolveAuthDir\(\)/);
});

test('FU-6: the same folder by two paths (a link) is watched once; two folders are watched twice', () => {
  const a = fs.mkdtempSync(path.join(real(os.tmpdir()), 'sj-w-'));
  const link = a + '-link';
  const b = fs.mkdtempSync(path.join(real(os.tmpdir()), 'sj-w2-'));
  fs.symlinkSync(a, link);
  try {
    const ws = journal.startWatches([a, link, path.join(a, '..', path.basename(a)), b], { intervalMs: 0 });
    try { assert.equal(ws.length, 2, 'the folder and its link: one watch; the other folder: another'); } finally { ws.forEach((w) => w.stop()); }
    assert.equal(journal.sameFolder(a, link), true);
    assert.equal(journal.sameFolder(a, b), false);
    // the install's data/ and an account folder that is a link to it: one watch
    const dl = path.join(real(os.tmpdir()), `sj-datalink-${process.pid}`);
    fs.symlinkSync(inst.data, dl);
    try {
      const w2 = journal.startWatches([inst.data, dl], { intervalMs: 0 });
      try { assert.equal(w2.length, 1); } finally { w2.forEach((w) => w.stop()); }
    } finally { fs.rmSync(dl, { force: true }); }
  } finally { fs.rmSync(link, { force: true }); fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /startWatches\(\[dataW, require\('\.\/lib\/auth'\)\.resolveAuthDir\(\)\]\)/);
});

test('R5-2: a store made with an explicit other folder keeps its journal beside it', () => {
  const other = fs.mkdtempSync(path.join(real(os.tmpdir()), 'sj-own-'));
  try {
    const au = authMod.createAuth({ dataDir: other, log: () => {} });
    const m = au.createUser({ login: 'own@example.com', name: 'Own', role: 'member', password: 'ad-long-password-1' }).user;
    au.setPrefs(m.id, { theme: 'dark' });
    assert.ok(lines(path.join(other, 'settings-journal.jsonl')).some((l) => l.key === `prefs.${m.id}.theme`), 'beside the explicit folder');
    assert.ok(!lines().some((l) => l.key === `prefs.${m.id}.theme`), 'not in the install journal');
  } finally { fs.rmSync(other, { recursive: true, force: true }); }
});
