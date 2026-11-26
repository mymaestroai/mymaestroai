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

// A fresh account folder outside the install; HUB_AUTH_DIR names it as `spell(dir)` says (absolute, or relative to the install folder).
function withAuthDir(spell, fn) {
  const dir = fs.mkdtempSync(path.join(real(os.tmpdir()), 'sj-acct-'));
  const was = process.env.HUB_AUTH_DIR;
  process.env.HUB_AUTH_DIR = spell(dir);
  try { return fn(dir); } finally { process.env.HUB_AUTH_DIR = was; fs.rmSync(dir, { recursive: true, force: true }); }
}
const SPELLINGS = { absolute: (d) => d, relative: (d) => path.relative(inst.inst, d) };   // a relative value is taken against the install folder

test('resolveAuthDir: HUB_AUTH_DIR resolved against the install folder (never the current one), else the install data/; no file is read when lib/auth loads', () => {
  assert.equal(typeof authMod.resolveAuthDir, 'function');
  assert.equal(authMod.resolveAuthDir({ HUB_AUTH_DIR: '/x/y' }), path.resolve('/x/y'));
  assert.equal(authMod.resolveAuthDir({ HUB_AUTH_DIR: 'rel/acct' }), path.join(inst.inst, 'rel', 'acct'));
  assert.notEqual(authMod.resolveAuthDir({ HUB_AUTH_DIR: 'rel/acct' }), path.resolve('rel/acct'));
  assert.equal(authMod.resolveAuthDir({}), path.join(inst.inst, 'data'));
  const src = fs.readFileSync(path.join(inst.lib, 'auth.js'), 'utf8');
  const head = src.slice(0, src.indexOf('function authDirFromEnvFile'));
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
        assert.equal(files[0].key, 'files/account/connectors.json', 'the moved folder\'s entry carries account/ like its markers');
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
  assert.match(src, /authW = require\('\.\/lib\/auth'\)\.resolveAuthDir\(\)/); assert.match(src, /startWatches\(authW \? \[dataW, authW\] : \[dataW\]\)/);
});

// ── R6-1 / R6-2: HUB_AUTH_DIR only in the install's .env, and a relative value, give every caller the same folder ──────────────────
const ENV_FILE = path.join(inst.inst, '.env');
const cleanEnv = () => ({ PATH: process.env.PATH, HOME: os.tmpdir() });   // no HUB_AUTH_DIR in the process environment
const here = (d) => { fs.mkdirSync(d, { recursive: true }); return d; };
const resolverIn = (cwd, env) => spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(inst.lib, 'auth'))}).resolveAuthDir())`], { env, cwd, encoding: 'utf8' }).stdout;
const tokenCli = (cwd, args) => spawnSync(process.execPath, [path.join(inst.inst, 'scripts', 'hub-token.js'), ...args], { env: cleanEnv(), cwd, encoding: 'utf8' });
const hubCli = (cwd, args) => spawnSync(process.execPath, [path.join(inst.inst, 'scripts', 'hub-cli.js'), ...args], { env: cleanEnv(), cwd, encoding: 'utf8' });

test('R6-1: HUB_AUTH_DIR only in the install\'s .env: the server-side resolver, hub-token and hub-cli all use that folder (a launch-time value is only the fallback)', () => {
  const acct = fs.mkdtempSync(path.join(real(os.tmpdir()), 'sj-envacct-'));
  const other = fs.mkdtempSync(path.join(real(os.tmpdir()), 'sj-envother-'));
  const cwd = here(path.join(inst.root, 'cwd-env'));
  fs.writeFileSync(ENV_FILE, `PORT=1\nHUB_AUTH_DIR=${acct}\nOTHER_KEY=secret-value\n`, { mode: 0o600 });
  try {
    assert.equal(resolverIn(cwd, cleanEnv()), acct, 'the resolver reads the one key from .env');
    assert.equal(resolverIn(cwd, { ...cleanEnv(), HUB_AUTH_DIR: other }), acct, 'the .env value comes first, as the server loads it over the environment');
    const t = tokenCli(cwd, ['create', '--name', 'env-only', '--scopes', 'status']);
    assert.equal(t.status, 0, t.stderr + t.stdout);
    assert.ok(fs.existsSync(path.join(acct, 'auth.db')), 'hub-token worked in the .env folder');
    assert.ok(!fs.existsSync(path.join(inst.data, 'auth.db')), 'not in data/');
    const c = hubCli(cwd, ['reset-2fa', 'nobody@example.com']);
    assert.match(c.stderr + c.stdout, /No account|root/i, 'hub-cli ran');
    assert.ok(!fs.existsSync(path.join(inst.data, 'auth.db')), 'hub-cli did not use data/ either');
    assert.match(tokenCli(cwd, ['list']).stdout, /env-only/, 'the same store on the next call');
    // the key is read lazily and nothing else is kept: the module exports no .env values
    assert.ok(!JSON.stringify(Object.keys(authMod)).includes('secret-value'));
  } finally { fs.rmSync(ENV_FILE, { force: true }); fs.rmSync(acct, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
});

test('R6-2: a relative HUB_AUTH_DIR (environment or .env) is the same store whatever folder hub-token and hub-cli start from', () => {
  const a = here(path.join(inst.root, 'cwd-a')), b = here(path.join(inst.root, 'cwd-b'));
  const store = path.join(inst.inst, 'acct-rel');
  try {
    // from the environment
    const env = { ...cleanEnv(), HUB_AUTH_DIR: 'acct-rel' };
    assert.equal(resolverIn(a, env), store);
    assert.equal(resolverIn(b, env), store);
    // from .env, tools launched from two different folders
    fs.writeFileSync(ENV_FILE, 'HUB_AUTH_DIR=acct-rel\n', { mode: 0o600 });
    const t = tokenCli(a, ['create', '--name', 'rel-a', '--scopes', 'status']);
    assert.equal(t.status, 0, t.stderr + t.stdout);
    assert.ok(fs.existsSync(path.join(store, 'auth.db')), 'created in <install>/acct-rel');
    assert.ok(!fs.existsSync(path.join(a, 'acct-rel')) && !fs.existsSync(path.join(b, 'acct-rel')), 'nothing under either working folder');
    assert.match(tokenCli(b, ['list']).stdout, /rel-a/, 'a command started from the other folder sees the same store');
    const c = hubCli(b, ['reset-2fa', 'nobody@example.com']);
    assert.match(c.stderr + c.stdout, /No account|root/i);
    assert.ok(!fs.existsSync(path.join(b, 'acct-rel')) && !fs.existsSync(path.join(b, 'data')), 'hub-cli left nothing under its working folder');
  } finally { fs.rmSync(ENV_FILE, { force: true }); fs.rmSync(store, { recursive: true, force: true }); }
});

test('R6 FU: an outside edit in the moved account folder is journaled as account/users.json (the data/ one stays users.json)', () => {
  withAuthDir((d) => d, (dir) => {
    journal.configure({ timers: fakeTimers(), notify: () => {} });
    rawWrite(path.join(dir, 'users.json'), '{"users":[]}');
    const w = journal.startWatch({ dataDir: authMod.resolveAuthDir(), intervalMs: 0 });
    try {
      w.tick();
      const n0 = journal.list({ limit: 500 }).filter((x) => x.store === 'files').length;
      rawWrite(path.join(dir, 'users.json'), '{"users":[{"id":"by-hand"}]}');
      w.tick();
      const files = journal.list({ limit: 500 }).filter((x) => x.store === 'files');
      assert.equal(files.length, n0 + 1);
      assert.equal(files[0].key, 'files/account/users.json');
    } finally { w.stop(); journal.configure({ clock: Date.now, timers: { setTimeout, clearTimeout }, notify: null }); }
  });
});

// ── R7-1: the .env value beats the environment (as the server loads it); R7-2: an unreadable .env stops everything ─────────────────
test('R7-1: conflicting .env and environment values: the server\'s own loading sequence, the resolver, hub-token and hub-cli pick the same folder', () => {
  const A = fs.mkdtempSync(path.join(real(os.tmpdir()), 'sj-r71-env-'));   // named by .env
  const B = fs.mkdtempSync(path.join(real(os.tmpdir()), 'sj-r71-proc-'));  // named by the launch environment
  const cwd = here(path.join(inst.root, 'cwd-r71'));
  const env = { PATH: process.env.PATH, HOME: os.tmpdir(), HUB_AUTH_DIR: B };
  const nodeE = (code) => spawnSync(process.execPath, ['-e', code], { env, cwd, encoding: 'utf8' });
  fs.writeFileSync(ENV_FILE, `PORT=1\nHUB_AUTH_DIR=${A}\n`, { mode: 0o600 });
  try {
    // seed a member in A so hub-cli finding the account proves it works on A
    const seed = nodeE(`require(${JSON.stringify(path.join(inst.lib, 'auth'))}).createAuth({dataDir:${JSON.stringify(A)},log:()=>{}}).createUser({login:'r71@example.com',name:'R71',role:'member',password:'r71-long-password-1'})`);
    assert.equal(seed.status, 0, seed.stderr);
    // the server's actual sequence (server.js: hubSecrets.loadEnvFile(<install>/.env) at start): the environment HUB_AUTH_DIR after it, and the resolver
    const seq = nodeE(`const hs=require(${JSON.stringify(path.join(inst.lib, 'hub-secrets'))});hs.loadEnvFile(${JSON.stringify(ENV_FILE)});
      const path=require('path');const a=require(${JSON.stringify(path.join(inst.lib, 'auth'))});
      process.stdout.write(JSON.stringify({ server: path.resolve(${JSON.stringify(inst.inst)}, process.env.HUB_AUTH_DIR || 'data'), resolver: a.resolveAuthDir() }))`);
    assert.equal(seq.status, 0, seq.stderr);
    const got = JSON.parse(seq.stdout);
    assert.equal(got.server, A, 'the server ends up on the .env folder');
    assert.equal(got.resolver, A, 'the resolver names the same one');
    assert.equal(resolverIn(cwd, env), A, 'the resolver by itself, before any loading');
    // hub-token
    const t = spawnSync(process.execPath, [path.join(inst.inst, 'scripts', 'hub-token.js'), 'create', '--name', 'r71', '--scopes', 'status'], { env, cwd, encoding: 'utf8' });
    assert.equal(t.status, 0, t.stderr + t.stdout);
    assert.ok(fs.existsSync(path.join(A, 'auth.db')), 'hub-token: the .env folder');
    assert.ok(!fs.existsSync(path.join(B, 'auth.db')), 'hub-token: not the environment folder');
    // hub-cli: it finds the account that lives in A only
    const c = spawnSync(process.execPath, [path.join(inst.inst, 'scripts', 'hub-cli.js'), 'reset-2fa', 'r71@example.com'], { env, cwd, encoding: 'utf8' });
    assert.ok(!/No account/.test(c.stderr + c.stdout), `hub-cli worked on the .env folder: ${c.stderr}${c.stdout}`);
    assert.ok(fs.readdirSync(B).length === 0, 'hub-cli left nothing in the environment folder');
    // an empty .env value is what the server reads too: data/, whatever the environment says
    fs.writeFileSync(ENV_FILE, 'HUB_AUTH_DIR=\n', { mode: 0o600 });
    assert.equal(resolverIn(cwd, env), path.join(inst.inst, 'data'));
    // no .env at all: the environment
    fs.rmSync(ENV_FILE, { force: true });
    assert.equal(resolverIn(cwd, env), B);
    assert.equal(resolverIn(cwd, { PATH: process.env.PATH, HOME: os.tmpdir() }), path.join(inst.inst, 'data'));
  } finally { fs.rmSync(ENV_FILE, { force: true }); fs.rmSync(A, { recursive: true, force: true }); fs.rmSync(B, { recursive: true, force: true }); }
});

test('R7-2: an .env that cannot be read (not ENOENT) makes the resolver throw naming it; hub-token and hub-cli print it, exit non-zero and open no store', { skip: typeof process.getuid === 'function' && process.getuid() === 0 ? 'running as root: chmod 000 does not stop root reading' : false }, () => {
  const cwd = here(path.join(inst.root, 'cwd-r72'));
  const env = { PATH: process.env.PATH, HOME: os.tmpdir() };
  fs.writeFileSync(ENV_FILE, 'HUB_AUTH_DIR=/tmp/never-used\n', { mode: 0o600 });
  fs.chmodSync(ENV_FILE, 0o000);
  const before = fs.readdirSync(inst.data).sort();
  try {
    const r = spawnSync(process.execPath, ['-e', `try{require(${JSON.stringify(path.join(inst.lib, 'auth'))}).resolveAuthDir();console.log('no throw')}catch(e){console.log(e instanceof Error, e.message)}`], { env, cwd, encoding: 'utf8' });
    assert.ok(r.stdout.startsWith('true '), r.stdout + r.stderr);
    assert.ok(r.stdout.includes(ENV_FILE), `the message names the unreadable path: ${r.stdout}`);
    const t = spawnSync(process.execPath, [path.join(inst.inst, 'scripts', 'hub-token.js'), 'list'], { env, cwd, encoding: 'utf8' });
    assert.notEqual(t.status, 0);
    assert.ok(t.stderr.includes(ENV_FILE), t.stderr);
    const c = spawnSync(process.execPath, [path.join(inst.inst, 'scripts', 'hub-cli.js'), 'reset-2fa', 'x@example.com'], { env, cwd, encoding: 'utf8' });
    assert.notEqual(c.status, 0);
    assert.ok(c.stderr.includes(ENV_FILE), c.stderr);
    assert.deepEqual(fs.readdirSync(inst.data).sort(), before, 'no store was opened in data/');
    assert.ok(!fs.existsSync(path.join('/tmp/never-used', 'auth.db')));
    // help still works without it
    assert.equal(spawnSync(process.execPath, [path.join(inst.inst, 'scripts', 'hub-cli.js'), 'help'], { env, cwd, encoding: 'utf8' }).status, 0);
  } finally { fs.chmodSync(ENV_FILE, 0o600); fs.rmSync(ENV_FILE, { force: true }); }
});

const NOT_ROOT = typeof process.getuid === 'function' && process.getuid() === 0 ? 'running as root: chmod 000 does not stop root reading' : false;

test('R8-3: with an unreadable .env only the commands that open the account store stop; logs, status, version and help run', { skip: NOT_ROOT }, () => {
  const cwd = here(path.join(inst.root, 'cwd-r83'));
  const env = { PATH: process.env.PATH, HOME: os.tmpdir() };
  fs.writeFileSync(ENV_FILE, 'HUB_AUTH_DIR=/tmp/never-used\n', { mode: 0o600 });
  fs.chmodSync(ENV_FILE, 0o000);
  const before = fs.readdirSync(inst.data).sort();
  const cli = (...a) => spawnSync(process.execPath, [path.join(inst.inst, 'scripts', 'hub-cli.js'), ...a], { env, cwd, encoding: 'utf8', timeout: 60000 });
  try {
    for (const c of ['reset-2fa', 'reset-password', 'setup-link', 'open', 'restore']) {
      const r = cli(c, 'x@example.com');
      assert.notEqual(r.status, 0, c);
      assert.ok(r.stderr.includes(ENV_FILE), `${c}: ${r.stderr}`);
    }
    for (const c of [['logs'], ['status'], ['version'], ['help']]) {
      const r = cli(...c);
      assert.ok(!(r.stderr + r.stdout).includes(ENV_FILE), `${c[0]} did not stop for the .env: ${r.stderr}${r.stdout}`);
      assert.ok(r.stdout.length > 0 || /No server.log/.test(r.stderr), `${c[0]} ran: ${r.stderr}`);
    }
    assert.equal(cli('help').status, 0);
    assert.equal(cli('version').status, 0);
    assert.ok(!fs.existsSync(path.join(inst.data, 'auth.db')), 'no store was opened');
    assert.deepEqual(fs.readdirSync(inst.data).sort(), before);
  } finally { fs.chmodSync(ENV_FILE, 0o600); fs.rmSync(ENV_FILE, { force: true }); }
});

test('R8-4: server start-up: an unreadable .env prints one [auth] line and exits non-zero (no stack); other errors still propagate', { skip: NOT_ROOT }, () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /const hubAuth = require\('\.\/lib\/auth'\)\.startAuthOrExit\(\)/, 'server.js starts the store through the helper');
  assert.ok(!/require\('\.\/lib\/auth'\)\.getAuth\(\)/.test(src), 'no bare getAuth() at start-up');
  const cwd = here(path.join(inst.root, 'cwd-r84'));
  const env = { PATH: process.env.PATH, HOME: os.tmpdir() };
  fs.writeFileSync(ENV_FILE, 'HUB_AUTH_DIR=/tmp/never-used\n', { mode: 0o600 });
  fs.chmodSync(ENV_FILE, 0o000);
  try {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(inst.lib, 'auth'))}).startAuthOrExit(); console.log('went on')`], { env, cwd, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.ok(!r.stdout.includes('went on'));
    const errLines = r.stderr.split('\n').filter(Boolean);
    assert.equal(errLines.length, 1, r.stderr);
    assert.ok(errLines[0].startsWith(`[auth] cannot read ${ENV_FILE}: `) && errLines[0].endsWith('Fix its permissions and start again.'), errLines[0]);
  } finally { fs.chmodSync(ENV_FILE, 0o600); fs.rmSync(ENV_FILE, { force: true }); }
});

test('R8-4: server.js starts the account store through startAuthOrExit (source check, also as root)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /const hubAuth = require\('\.\/lib\/auth'\)\.startAuthOrExit\(\)/);
  assert.equal(typeof authMod.startAuthOrExit, 'function');
});

test('R8-5: the journal never falls back to another folder when the .env cannot be read', { skip: NOT_ROOT }, () => {
  const src = fs.readFileSync(path.join(inst.lib, 'settings-journal.js'), 'utf8');
  const body = src.slice(src.indexOf('function configuredAuthDir'), src.indexOf('function journalDirFor'));
  assert.ok(!/catch/.test(body), 'configuredAuthDir has no fallback');
  fs.writeFileSync(ENV_FILE, 'HUB_AUTH_DIR=/tmp/never-used\n', { mode: 0o600 });
  fs.chmodSync(ENV_FILE, 0o000);
  try {
    const r = spawnSync(process.execPath, ['-e', `const j=require(${JSON.stringify(path.join(inst.lib, 'settings-journal'))});try{j.recordPrefs(${JSON.stringify(path.join(inst.root, 'elsewhere', 'x.json'))},[{key:'prefs.u.s.f',before:1,after:2}]);console.log('no throw')}catch(e){console.log('threw',e.message)}`], { env: { PATH: process.env.PATH, HOME: os.tmpdir() }, cwd: inst.root, encoding: 'utf8' });
    assert.ok(/^threw /.test(r.stdout), r.stdout + r.stderr);
  } finally { fs.chmodSync(ENV_FILE, 0o600); fs.rmSync(ENV_FILE, { force: true }); }
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
