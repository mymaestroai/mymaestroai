'use strict';
// `mymaestro reset-password <email>` (scripts/hub-cli.js) and the account store it relies on (lib/auth.js mutate/load/clearFailures).
// Every test uses its own temp data dir; the real data/ is never touched. No test prints a password.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// lib/ and scripts/ come from a throwaway install, so nothing under the real data/ is touched.
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('auth-reset-pw-iso-', { copy: ['scripts'] });
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'auth-reset-pw-'));
const CLI_FILE = path.join(ISO.inst, 'scripts', 'hub-cli.js');
const A = require(path.join(ISO.inst, 'lib', 'auth'));
const CLI = require(CLI_FILE);
const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));

const T0 = Date.parse('2026-01-01T00:00:00Z');
const OLD = 'old password number one';
const NEW = 'brand new password two';

function fresh() {
  const dir = fs.mkdtempSync(path.join(TMP, 'd-'));
  const logs = [];
  const mk = () => A.createAuth({ dataDir: dir, now: () => T0, log: (l) => logs.push(l) });
  return { dir, logs, mk, hub: mk(), file: path.join(dir, 'users.json') };
}
// The reader a terminal would give: answers in order; records the prompts.
function reader(answers) { const prompts = []; const q = answers.slice(); const read = async (p) => { prompts.push(p); return q.shift(); }; read.prompts = prompts; return read; }
function run(login, opts) {
  const said = [], err = [];
  return CLI.resetPassword(login, { interactive: true, say: (s) => said.push(s), sayErr: (s) => err.push(s), ...opts }).then((code) => ({ code, said, err }));
}
const dbRows = (dir, sql, ...p) => { const d = new Database(path.join(dir, 'auth.db'), { readonly: true }); try { return d.prepare(sql).all(...p); } finally { d.close(); } };
const onDisk = (file, id) => JSON.parse(fs.readFileSync(file, 'utf8')).users.find(x => x.id === id);

test('reset-password: sets the new password after two matching, policy-passing entries', async () => {
  const { hub, mk } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  const cli = mk();
  const read = reader([NEW, NEW]);
  const r = await run('Person@Example.com', { a: cli, read });
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(read.prompts, ['New password: ', 'Type it again: ']);
  assert.strictEqual(r.said.length, 1);
  assert.strictEqual(r.said[0], 'Password set for person@example.com. Every other sign-in of this account was signed out. Sign in with the new password; if the phone with two-factor is lost too, run: mymaestro reset-2fa person@example.com');
  assert.strictEqual(hub.login('person@example.com', NEW).ok, true);
  assert.strictEqual(mk().login('person@example.com', OLD).ok, false);
  assert.ok(u.id);
});

test('reset-password: a turned-off account gets the extra line', async () => {
  const { hub, mk } = fresh();
  hub.createUser({ login: 'boss@example.com', role: 'admin', password: OLD });
  const u = hub.createUser({ login: 'off@example.com', password: OLD }).user;
  assert.ok(hub.updateUser(u.id, { disabled: true }).ok);
  const r = await run('off@example.com', { a: mk(), read: reader([NEW, NEW]) });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.said.length, 2);
  assert.match(r.said[1], /^This account is turned off; an admin can turn it back on on the Users page/);
});

test('reset-password: the password policy refuses, the message is shown, and it asks again; three failures stop it unchanged', async () => {
  const { hub, mk, file } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  const before = onDisk(file, u.id).passwordHash;
  // one short entry, then a good pair
  let read = reader(['short', NEW, NEW]);
  let r = await run('person@example.com', { a: mk(), read });
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(r.said[0], 'Password must be at least 12 characters');
  assert.deepStrictEqual(read.prompts, ['New password: ', 'New password: ', 'Type it again: ']);
  // three bad tries (policy, mismatch, policy): exit non-zero and the password is the one set before
  hub.setPassword(u.id, OLD);
  const before2 = onDisk(file, u.id).passwordHash;
  read = reader(['tiny', NEW, 'does not match it', 'x']);
  r = await run('person@example.com', { a: mk(), read });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(r.said[1], 'The two passwords are not the same. Try again.');
  assert.strictEqual(r.err[0], 'Too many tries. The password was not changed.');
  assert.strictEqual(onDisk(file, u.id).passwordHash, before2);
  assert.notStrictEqual(before, before2);
});

test('reset-password: an unknown account says so, exits non-zero and reveals nothing else', async () => {
  const { mk } = fresh();
  const read = reader([NEW, NEW]);
  const r = await run('nobody@example.com', { a: mk(), read });
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(r.err, ['No account "nobody@example.com".']);
  assert.deepStrictEqual(r.said, []);
  assert.deepStrictEqual(read.prompts, [], 'no password is asked for');
  assert.strictEqual((await run('', { a: mk(), read })).code, 1);
});

test('reset-password: that account\'s sessions and trusted devices end, another account\'s stay', async () => {
  const { hub, mk, dir } = fresh();
  const a1 = hub.createUser({ login: 'one@example.com', password: OLD }).user;
  const a2 = hub.createUser({ login: 'two@example.com', password: OLD }).user;
  hub.createSession(a1); hub.createSession(a1); hub.createSession(a2);
  hub.trustDevice(a1, null); hub.trustDevice(a2, null);
  assert.strictEqual(hub.listSessions(a1.id).length, 2);
  const r = await run('one@example.com', { a: mk(), read: reader([NEW, NEW]) });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(hub.listSessions(a1.id).length, 0);
  assert.strictEqual(hub.listSessions(a2.id).length, 1);
  assert.deepStrictEqual(dbRows(dir, 'SELECT user_id FROM trusted').map(x => x.user_id), [a2.id]);
});

test('reset-password: the audit line says password.set, by cli, with the login and no password text', async () => {
  const { hub, mk, logs } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  const cli = mk();
  await run('person@example.com', { a: cli, read: reader([NEW, NEW]) });
  const rows = cli.auditRecent(50).filter(x => x.action === 'password.set');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].user_id, 'cli');
  assert.strictEqual(rows[0].detail, 'person@example.com');
  const everything = JSON.stringify(cli.auditRecent(500)) + logs.join('\n');
  assert.ok(!everything.includes(NEW) && !everything.includes(OLD), 'no password text in the audit or the log');
  assert.ok(u.id);
});

test('reset-password: failed sign-ins of that login are forgotten, another login\'s are kept', async () => {
  const { hub, mk, dir } = fresh();
  hub.createUser({ login: 'one@example.com', password: OLD });
  hub.createUser({ login: 'two@example.com', password: OLD });
  for (let i = 0; i < 3; i++) { hub.login('one@example.com', 'wrong password here'); hub.login('two@example.com', 'wrong password here'); }
  const count = (l) => dbRows(dir, 'SELECT COUNT(*) AS n FROM attempts WHERE login = ? AND ok = 0', l)[0].n;
  assert.strictEqual(count('one@example.com'), 3);
  await run('one@example.com', { a: mk(), read: reader([NEW, NEW]) });
  assert.strictEqual(count('one@example.com'), 0);
  assert.strictEqual(count('two@example.com'), 3);
});

test('clearFailures: only that login\'s failed attempts; successful ones and other logins stay', () => {
  const { hub, dir } = fresh();
  hub.createUser({ login: 'one@example.com', password: OLD });
  hub.login('one@example.com', 'wrong password here');
  hub.login('one@example.com', OLD);                 // a good sign-in (the row is kept, ok = 1)
  hub.login('one@example.com', 'wrong password here');
  hub.clearFailures('ONE@example.com');
  assert.deepStrictEqual(dbRows(dir, 'SELECT ok FROM attempts WHERE login = ?', 'one@example.com').map(x => x.ok), [1]);
});

test('reset-password: two-factor stays as it was', async () => {
  const { hub, mk, file } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  const b = hub.totpBegin(u.id);
  const c = hub.totpConfirm(u.id, A.totpCode(b.secret, { now: T0 }));
  assert.ok(c.ok);
  const before = JSON.stringify([onDisk(file, u.id).totp, onDisk(file, u.id).recovery, onDisk(file, u.id).totpLastCounter]);
  const r = await run('person@example.com', { a: mk(), read: reader([NEW, NEW]) });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(JSON.stringify([onDisk(file, u.id).totp, onDisk(file, u.id).recovery, onDisk(file, u.id).totpLastCounter]), before);
  assert.strictEqual(hub.getUser(u.id).totp.enabled, true);
  assert.strictEqual(hub.login('person@example.com', NEW).needsTotp, true);
});

test('running hub: reset-password by the command is seen by a hub that already loaded, and its next save keeps it', async () => {
  const { hub, mk, file } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  hub.listUsers();
  const r = await run('person@example.com', { a: mk(), read: reader([NEW, NEW]) });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(hub.login('person@example.com', OLD).ok, false);
  assert.strictEqual(hub.login('person@example.com', NEW).ok, true);   // saves lastLoginAt
  assert.ok(hub.setTimeZone(u.id, 'Europe/Paris').ok);
  assert.ok(A.verifyPassword(NEW, onDisk(file, u.id).passwordHash));
  assert.strictEqual(onDisk(file, u.id).timeZone, 'Europe/Paris');
});

test('running hub: reset-2fa by the command (totpDisable) is seen at once and survives the hub\'s next save', () => {
  const { hub, mk, file } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  const b = hub.totpBegin(u.id);
  assert.ok(hub.totpConfirm(u.id, A.totpCode(b.secret, { now: T0 })).ok);
  hub.listUsers();
  assert.ok(mk().totpDisable(u.id, { by: 'cli' }).ok);
  assert.strictEqual(hub.listUsers()[0].totpEnabled, false);
  assert.strictEqual(hub.login('person@example.com', OLD).needsTotp, false);
  assert.ok(hub.setTimeZone(u.id, 'Europe/Paris').ok);
  assert.ok(!onDisk(file, u.id).totp);
});

test('a stale save never overwrites a newer file: hub loads, command changes, hub changes something else, both are in the file', () => {
  const { hub, mk, file } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  hub.listUsers();
  const cli = mk();
  assert.ok(cli.setPassword(u.id, NEW, { by: 'cli' }).ok);
  assert.ok(hub.setPrefs(u.id, { theme: 'dark' }).ok);
  assert.ok(cli.createUser({ login: 'second@example.com', password: OLD }).ok);
  assert.ok(hub.setTimeZone(u.id, 'Europe/Paris').ok);
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(d.users.map(x => x.login).sort(), ['person@example.com', 'second@example.com']);
  const p = d.users.find(x => x.id === u.id);
  assert.ok(A.verifyPassword(NEW, p.passwordHash));
  assert.deepStrictEqual([p.theme, p.timeZone], ['dark', 'Europe/Paris']);
});

test('a change by someone else between the load and the rename: the write starts over from the new file (nothing lost)', () => {
  const { hub, mk, file } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  hub.listUsers();
  const cli = mk();
  const realFsync = fs.fsyncSync;
  let fired = false;
  fs.fsyncSync = function (fd) {
    const r = realFsync.call(fs, fd);
    if (!fired) { fired = true; fs.fsyncSync = realFsync; cli.setPrefs(u.id, { uiMode: 'advanced' }); }   // the other process writes while the hub is about to rename
    return r;
  };
  try { assert.ok(hub.setPrefs(u.id, { theme: 'dark' }).ok); } finally { fs.fsyncSync = realFsync; }
  assert.ok(fired);
  const p = onDisk(file, u.id);
  assert.deepStrictEqual([p.uiMode, p.theme], ['advanced', 'dark']);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp')), [], 'no temp file is left behind');
});

test('a file that keeps changing: gives up after 3 tries with a clear error, saves nothing of its own and leaves no temp file', () => {
  const { hub, mk, file } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  hub.listUsers();
  const cli = mk();
  const realFsync = fs.fsyncSync;
  let busy = false, n = 0;
  fs.fsyncSync = function (fd) {
    const r = realFsync.call(fs, fd);
    if (!busy) { busy = true; try { cli.setPrefs(u.id, { uiMode: n++ % 2 ? 'simple' : 'advanced' }); } finally { busy = false; } }
    return r;
  };
  try { assert.throws(() => hub.setPrefs(u.id, { theme: 'dark' }), /keeps changing/); } finally { fs.fsyncSync = realFsync; }
  assert.ok(!onDisk(file, u.id).theme, 'the hub\'s own change was not written');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp')), []);
  assert.ok(hub.setPrefs(u.id, { theme: 'dark' }).ok, 'and it works again afterwards');
});

test('the temp file is opened with flag wx and mode 0600 under a random name; a symlink at the old fixed name is never followed', () => {
  const { hub, dir, file } = fresh();
  const victim = path.join(TMP, 'victim.txt');
  fs.writeFileSync(victim, 'untouched');
  fs.symlinkSync(victim, `${file}.tmp`);   // the old fixed temp name
  const realOpen = fs.openSync;
  const opened = [];
  fs.openSync = function (p, flags, mode) { if (/\.users\.[0-9a-f]+\.tmp$/.test(String(p))) opened.push({ p: String(p), flags, mode }); return realOpen.apply(fs, arguments); };
  try {
    hub.createUser({ login: 'one@example.com', password: OLD });
    hub.createUser({ login: 'two@example.com', password: OLD });
  } finally { fs.openSync = realOpen; }
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'untouched');
  assert.strictEqual(opened.length, 2);
  for (const o of opened) { assert.strictEqual(o.flags, 'wx'); assert.strictEqual(o.mode, 0o600); assert.strictEqual(path.dirname(o.p), dir); }
  assert.notStrictEqual(opened[0].p, opened[1].p, 'a new random name each time');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.startsWith('.users.')), [], 'no temp file is left behind');
});

test('an unreadable users.json: the copy in memory is kept and one line is logged', () => {
  const { hub, logs, file } = fresh();
  hub.createUser({ login: 'person@example.com', password: OLD });
  assert.strictEqual(hub.listUsers().length, 1);
  fs.writeFileSync(file, '{ not json');
  assert.strictEqual(hub.listUsers().length, 1);
  assert.strictEqual(hub.listUsers().length, 1);
  assert.strictEqual(logs.filter(l => /users\.json could not be read/.test(l)).length, 1);
  assert.ok(!logs.join('\n').includes(OLD));
});

test('a missing users.json is an empty account list, as before', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'd-'));
  const a = A.createAuth({ dataDir: dir, log: () => {} });
  assert.deepStrictEqual(a.listUsers(), []);
  assert.strictEqual(a.hasUsers(), false);
  assert.ok(a.createUser({ login: 'first@example.com', password: OLD }).ok);
  assert.strictEqual(A.createAuth({ dataDir: dir, log: () => {} }).listUsers().length, 1);
});

test('the command refuses without a terminal: piped stdin gets the refusal, a non-zero exit, and no password is read or printed', () => {
  const home = fs.mkdtempSync(path.join(TMP, 'home-'));
  const r = spawnSync(process.execPath, [CLI_FILE, 'reset-password', 'person@example.com'],
    { input: `${NEW}\n${NEW}\n`, encoding: 'utf8', cwd: home, env: { ...process.env, HOME: home, HUB_HOME: home, HUB_AUTH_DIR: path.join(home, 'data') }, timeout: 20000 });
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(r.stderr.trim(), 'reset-password asks for the new password in a terminal; run it in a terminal on the computer that runs your Maestro.');
  assert.ok(!(r.stdout + r.stderr).includes(NEW));
  assert.ok(!fs.existsSync(path.join(home, 'data')), 'nothing was created');
});

test('help lists reset-password beside reset-2fa, the usage text is in the header, and the command is a real command', () => {
  const r = spawnSync(process.execPath, [CLI_FILE, 'help'], { encoding: 'utf8', cwd: ISO.inst, env: { ...process.env, HOME: ISO.home, HUB_HOME: ISO.home, HUB_AUTH_DIR: ISO.data }, timeout: 20000 });
  assert.strictEqual(r.status, 0);
  const lines = r.stdout.split('\n').map(l => l.trim());
  const i = lines.findIndex(l => l.startsWith('mymaestro reset-2fa <email>'));
  assert.ok(i >= 0);
  assert.strictEqual(lines[i + 1], 'mymaestro reset-password <email>   set a new password for an account (forgotten password); asks for it twice, hidden');
  assert.ok(lines.some(l => l.startsWith('mymaestro version')), 'the last line of the help is still there');
  assert.match(fs.readFileSync(CLI_FILE, 'utf8'), /^  async 'reset-password'\(\)/m);
});

test('the sign-in page has the muted forgotten-password line under the password field', () => {
  const html = fs.readFileSync(path.join(ROOT, 'login.html'), 'utf8');
  const form = html.slice(html.indexOf('id="f-login"'), html.indexOf('</form>', html.indexOf('id="f-login"')));
  const pw = form.indexOf('id="login-password"');
  const hint = form.indexOf('Forgot it? On the computer that runs your Maestro, run: <code>mymaestro reset-password &lt;your email&gt;</code>');
  assert.ok(pw > 0 && hint > pw);
  assert.ok(hint < form.indexOf('type="submit"'));
});
