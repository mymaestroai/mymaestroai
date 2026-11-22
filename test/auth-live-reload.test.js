'use strict';
// The running hub and the mymaestro command are two processes on one data dir. Account changes made by one must be seen by the other,
// and a save by the hub must never write over a change the command made after the hub loaded users.json.
// A = "the running hub" (has loaded), B = "the CLI" (its own auth instance on the same dir).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// lib/ comes from a throwaway install, so nothing under the real data/ is touched.
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('auth-live-reload-iso-');
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'auth-live-reload-'));
const A = require(path.join(ISO.inst, 'lib', 'auth'));

const T0 = Date.parse('2026-01-01T00:00:00Z');
const OLD = 'old password number one';
const NEW = 'brand new password two';

function setup() {
  const dir = fs.mkdtempSync(path.join(TMP, 'd-'));
  const clock = { t: T0 };
  const mk = () => A.createAuth({ dataDir: dir, now: () => clock.t, log: () => {} });
  const hub = mk();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  const b = hub.totpBegin(u.id);
  assert.ok(hub.totpConfirm(u.id, A.totpCode(b.secret, { now: clock.t })).ok);
  const cli = mk();
  hub.listUsers();   // the hub has loaded
  return { dir, clock, hub, cli, id: u.id, file: path.join(dir, 'users.json') };
}
const onDisk = (file, id) => JSON.parse(fs.readFileSync(file, 'utf8')).users.find(x => x.id === id);

test('before/after: the CLI turns two-factor off; the running hub sees it and its next save keeps it', () => {
  const { hub, cli, id, file } = setup();
  assert.ok(hub.getUser(id).totp, 'precondition: the hub sees two-factor on');
  assert.ok(cli.totpDisable(id, { by: 'cli' }).ok);
  assert.ok(!hub.getUser(id).totp, 'the hub must see two-factor off');
  assert.strictEqual(hub.listUsers().find(x => x.id === id).totpEnabled, false);
  assert.ok(hub.setTimeZone(id, 'Europe/Paris').ok);
  const d = onDisk(file, id);
  assert.strictEqual(d.timeZone, 'Europe/Paris');
  assert.ok(!d.totp, 'the file must still hold the CLI change after the hub saved');
  assert.deepStrictEqual(d.recovery, []);
});

test('before/after: the CLI sets a new password; the running hub signs in with it, not the old one, and its next save keeps it', () => {
  const { hub, cli, id, file } = setup();
  assert.ok(cli.setPassword(id, NEW, { by: 'cli' }).ok);
  assert.strictEqual(hub.login('person@example.com', OLD).ok, false, 'old password must fail in the hub');
  assert.strictEqual(hub.login('person@example.com', NEW).ok, true, 'new password must work in the hub');
  // login saved lastLoginAt; the file must still verify the new password
  const d = onDisk(file, id);
  assert.ok(d.lastLoginAt);
  assert.ok(A.verifyPassword(NEW, d.passwordHash));
  assert.ok(!A.verifyPassword(OLD, d.passwordHash));
});

test('before/after: a stale save never overwrites a newer file (hub loaded, CLI changes, hub changes something else)', () => {
  const { hub, cli, id, file } = setup();
  assert.ok(cli.setPassword(id, NEW, { by: 'cli' }).ok);
  assert.ok(hub.setPrefs(id, { theme: 'dark' }).ok);
  const d = onDisk(file, id);
  assert.strictEqual(d.theme, 'dark');
  assert.ok(A.verifyPassword(NEW, d.passwordHash), 'both changes are in the file');
});

test('r1: several processes adding accounts at the same time lose none (users.json.lock around read-modify-replace)', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'd-'));
  const code = "const A=require(process.argv[1]);const a=A.createAuth({dataDir:process.argv[2],log:()=>{}});"
    + "for(let i=0;i<10;i++){const r=a.createUser({login:'p'+process.argv[3]+'-'+i+'@example.com'});if(!r.ok){console.error(r.error);process.exit(2);}}";
  const run = (n) => new Promise((resolve) => {
    const c = require('child_process').spawn(process.execPath, ['-e', code, path.join(ISO.inst, 'lib', 'auth'), dir, String(n)], { stdio: ['ignore', 'ignore', 'inherit'] });
    c.on('close', resolve);
  });
  const codes = await Promise.all([1, 2, 3, 4].map(run));
  assert.deepStrictEqual(codes, [0, 0, 0, 0]);
  const users = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8')).users;
  assert.strictEqual(users.length, 40, 'every account is in the file');
  assert.strictEqual(new Set(users.map(u => u.login)).size, 40);
  assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp') || f.endsWith('.lock')), []);
});
