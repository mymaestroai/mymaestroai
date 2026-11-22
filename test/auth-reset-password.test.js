'use strict';
// `mymaestro reset-password <email>` (scripts/hub-cli.js) and the account store it relies on (lib/auth.js mutate/load/clearFailures).
// Every test uses its own temp data dir; the real data/ is never touched. No test prints a password.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

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
// A writer from an older version: it does not take users.json.lock, it writes a temp file and renames it over users.json.
function legacyWrite(file, change) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  change(d);
  const tmp = `${file}.legacy-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

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
  const realFsync = fs.fsyncSync;
  let fired = false;
  fs.fsyncSync = function (fd) {
    const r = realFsync.call(fs, fd);
    // an older version (it takes no lock) writes while the hub is about to rename
    if (!fired) { fired = true; fs.fsyncSync = realFsync; legacyWrite(file, (d) => { d.users.find(x => x.id === u.id).uiMode = 'advanced'; }); }
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
  const realFsync = fs.fsyncSync;
  let busy = false, n = 0;
  fs.fsyncSync = function (fd) {
    const r = realFsync.call(fs, fd);
    if (!busy) { busy = true; try { legacyWrite(file, (d) => { d.users.find(x => x.id === u.id).uiMode = n++ % 2 ? 'simple' : 'advanced'; }); } finally { busy = false; } }   // an older version, no lock
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

// ── Review round 1: an unreadable file, the lock, the owner, sessions after a reset, the terminal prompt ──
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const SKIP_ROOT = IS_ROOT ? 'running as root: mode 000 does not lock the owner out' : false;
const leftovers = (dir) => fs.readdirSync(dir).filter(f => f.endsWith('.tmp') || f.endsWith('.lock'));

test('r1 unreadable: a users.json that cannot be read keeps the copy in memory, a change is refused and saves nothing, sign-in still works', { skip: SKIP_ROOT }, () => {
  const { hub, logs, file, dir } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  hub.listUsers();
  const before = fs.readFileSync(file, 'utf8');
  fs.chmodSync(file, 0);
  try {
    assert.strictEqual(hub.listUsers().length, 1, 'reads keep serving the copy in memory');
    assert.throws(() => hub.setPrefs(u.id, { theme: 'dark' }), /users\.json can't be read.*nothing was saved.*sudo/);
    assert.strictEqual(hub.login('person@example.com', OLD).ok, true, 'people can still sign in');
    assert.strictEqual(hub.login('person@example.com', OLD).ok, true);
    assert.strictEqual(logs.filter(l => /sign-in went through but its time was not saved/.test(l)).length, 1, 'logged once');
    assert.throws(() => hub.createSession(hub.getUser(u.id)), /the account changed; sign in again/, 'R2: but no session starts while users.json cannot be read');
  } finally { fs.chmodSync(file, 0o600); }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'the file is unchanged');
  assert.deepStrictEqual(leftovers(dir), [], 'no temp file and no lock left');
  assert.ok(hub.setPrefs(u.id, { theme: 'dark' }).ok, 'works again once it can be read');
});

test('r1 unreadable: a NEWER file that cannot be read (written by root) is never overwritten by the older copy in memory', { skip: SKIP_ROOT }, () => {
  const { hub, mk, file } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  hub.listUsers();
  assert.ok(mk().setPassword(u.id, NEW, { by: 'cli' }).ok);   // the newer file
  const newer = fs.readFileSync(file, 'utf8');
  fs.chmodSync(file, 0);
  try {
    assert.strictEqual(hub.listUsers().length, 1);
    assert.throws(() => hub.setTimeZone(u.id, 'Europe/Paris'), /can't be read/);
    assert.throws(() => hub.setPrefs(u.id, { theme: 'dark' }), /can't be read/, 'still refused the second time');
  } finally { fs.chmodSync(file, 0o600); }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), newer, 'the newer file is untouched');
  assert.ok(A.verifyPassword(NEW, onDisk(file, u.id).passwordHash));
  assert.strictEqual(hub.login('person@example.com', OLD).ok, false, 'once readable the hub follows the new file');
  assert.strictEqual(hub.login('person@example.com', NEW).ok, true);
});

test('r1 vanished: a users.json that disappears after a load keeps the copy, a change is refused and nothing is created', () => {
  const { hub, dir, file } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  hub.listUsers();
  fs.unlinkSync(file);
  assert.strictEqual(hub.listUsers().length, 1, 'the copy in memory is served');
  assert.throws(() => hub.setPrefs(u.id, { theme: 'dark' }), /users\.json can't be read.*nothing was saved/);
  assert.ok(!fs.existsSync(file), 'no users.json was made');
  assert.deepStrictEqual(leftovers(dir), []);
  assert.strictEqual(hub.login('person@example.com', OLD).ok, true, 'sign-in still works');
  assert.ok(!fs.existsSync(file));
  fs.rmSync(dir, { recursive: true, force: true });   // the whole folder gone: still nothing is created
  assert.throws(() => hub.setPrefs(u.id, { theme: 'dark' }), /can't be read/);
  assert.ok(!fs.existsSync(dir), 'not even the folder');
});

test('r1 vanished: reset-password reports the refusal and exits 1 instead of crashing', async () => {
  const { hub, mk, file } = fresh();
  hub.createUser({ login: 'person@example.com', password: OLD });
  const cli = mk();
  cli.listUsers();
  fs.unlinkSync(file);
  const r = await run('person@example.com', { a: cli, read: reader([NEW, NEW]) });
  assert.strictEqual(r.code, 1);
  assert.match(r.err[0], /users\.json can't be read/);
  assert.ok(!fs.existsSync(file));
});

test('r1 lock: a fresh lock held by another process makes the change wait, then it succeeds once the lock is released', async () => {
  const { hub, dir, file } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  const lock = path.join(dir, 'users.json.lock');
  // The child holds the lock for 1.5 s and reports the moment it let go; timing does not depend on how fast its output arrives.
  const child = spawn(process.execPath, ['-e', "const fs=require('fs');fs.writeFileSync(process.argv[1],'x',{flag:'wx'});console.log('ready');setTimeout(()=>{const t=Date.now();fs.unlinkSync(process.argv[1]);console.log('released '+t);},1500);", lock], { stdio: ['ignore', 'pipe', 'inherit'] });
  let outText = '';
  child.stdout.on('data', (d) => { outText += d; });
  await new Promise((res, rej) => { child.stdout.once('data', res); child.once('error', rej); });
  assert.ok(fs.existsSync(lock), 'the lock is held');
  assert.ok(hub.setPrefs(u.id, { theme: 'dark' }).ok);   // blocks while the lock is held
  const done = Date.now();
  await new Promise((res) => child.once('close', res));
  const released = Number((outText.match(/released (\d+)/) || [])[1]);
  assert.ok(released > 0, 'the child released the lock');
  assert.ok(done >= released, `the save finished only after the lock was released (${done - released} ms after)`);
  assert.strictEqual(onDisk(file, u.id).theme, 'dark');
  assert.ok(!fs.existsSync(lock), 'the lock is released afterwards');
});

test('r1 lock: a lock that stays gives up after about 3 s with "busy" and saves nothing; the other holder\'s lock is not removed', () => {
  const { hub, dir, file } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  const lock = path.join(dir, 'users.json.lock');
  fs.writeFileSync(lock, 'someone else', { flag: 'wx' });
  const t0 = Date.now();
  assert.throws(() => hub.setPrefs(u.id, { theme: 'dark' }), /users\.json is busy; nothing was saved\. Try again\./);
  const waited = Date.now() - t0;
  assert.ok(waited >= 2900 && waited < 8000, `waited ${waited} ms`);
  assert.strictEqual(fs.readFileSync(lock, 'utf8'), 'someone else');
  assert.ok(!onDisk(file, u.id).theme);
  fs.unlinkSync(lock);
});

test('r1 lock: a stale lock (older than 10 s) is taken over, once logged, and removed afterwards', () => {
  const { hub, dir, file, logs } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  const lock = path.join(dir, 'users.json.lock');
  for (let i = 0; i < 2; i++) {
    fs.writeFileSync(lock, 'a process that stopped');
    const old = new Date(Date.now() - 20000);
    fs.utimesSync(lock, old, old);
    const t0 = Date.now();
    assert.ok(hub.setPrefs(u.id, { theme: i ? 'light' : 'dark' }).ok);
    assert.ok(Date.now() - t0 < 2000, 'no waiting for a stale lock');
    assert.ok(!fs.existsSync(lock));
  }
  assert.strictEqual(onDisk(file, u.id).theme, 'light');
  assert.strictEqual(logs.filter(l => /users\.json\.lock was left behind/.test(l)).length, 1, 'logged once');
});

test('r1 lock: temp files older than 60 s are removed under the lock, fresh ones are left', () => {
  const { hub, dir } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  const oldTmp = path.join(dir, '.users.deadbeef.tmp'), freshTmp = path.join(dir, '.users.cafe.tmp');
  fs.writeFileSync(oldTmp, 'x'); fs.writeFileSync(freshTmp, 'x');
  const old = new Date(Date.now() - 120000); fs.utimesSync(oldTmp, old, old);
  assert.ok(hub.setPrefs(u.id, { theme: 'dark' }).ok);
  assert.ok(!fs.existsSync(oldTmp));
  assert.ok(fs.existsSync(freshTmp));
});

test('r1 lock: a change always re-reads users.json under the lock, even when another writer left the same size and the same mtime', () => {
  const { hub, file } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  assert.ok(hub.setPrefs(u.id, { theme: 'dark' }).ok);
  const T = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(file, T, T);
  hub.listUsers();   // the hub loads: its stamp is (T, size, inode)
  const ino = fs.statSync(file).ino;
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"theme": "dark"', '"theme": "lite"'));   // in place: same inode, same size
  fs.utimesSync(file, T, T);
  assert.strictEqual(fs.statSync(file).ino, ino);
  assert.ok(hub.setPrefs(u.id, { uiMode: 'advanced' }).ok);
  const d = onDisk(file, u.id);
  assert.strictEqual(d.theme, 'lite', 'the other writer\'s change survives');
  assert.strictEqual(d.uiMode, 'advanced');
});

test('r1 root: keepFileOwner changes the owner of the open file to the existing users.json owner, else the data folder\'s, only as root', () => {
  const calls = [];
  const fchown = (fd, uid, gid) => calls.push([fd, uid, gid]);
  const fstat = () => ({ uid: calls[calls.length - 1][1], gid: calls[calls.length - 1][2] });   // the chown took
  const owners = { '/d/users.json': { uid: 1001, gid: 1002 }, '/d': { uid: 2001, gid: 2002 } };
  const mkStat = (has) => (p) => { if (p === '/d/users.json' && !has) { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } return owners[p]; };
  const o = { dataDir: '/d', usersFile: '/d/users.json' };
  assert.deepStrictEqual(A.keepFileOwner(7, { ...o, getuid: () => 0, fchown, fstat, stat: mkStat(true) }), { uid: 1001, gid: 1002 });
  assert.deepStrictEqual(A.keepFileOwner(8, { ...o, getuid: () => 0, fchown, fstat, stat: mkStat(false) }), { uid: 2001, gid: 2002 });
  assert.strictEqual(A.keepFileOwner(9, { ...o, getuid: () => 1000, fchown, stat: mkStat(true) }), null);
  assert.strictEqual(A.keepFileOwner(9, { ...o, getuid: null, fchown, stat: mkStat(true) }), null);
  assert.deepStrictEqual(calls, [[7, 1001, 1002], [8, 2001, 2002]]);
});

test('r2 root: as root a chown that fails, or that does not take (fstat shows another owner), throws; nothing is saved and no temp file stays', () => {
  const o = { dataDir: '/d', usersFile: '/d/users.json' };
  const stat = () => ({ uid: 1001, gid: 1002 });
  assert.throws(() => A.keepFileOwner(5, { ...o, getuid: () => 0, fchown: () => { throw new Error('EPERM'); }, stat }), /owner could not be kept/);
  assert.throws(() => A.keepFileOwner(5, { ...o, getuid: () => 0, fchown: () => {}, stat, fstat: () => ({ uid: 0, gid: 0 }) }), /owner could not be kept/);
  assert.throws(() => A.keepFileOwner(5, { ...o, getuid: () => 0, fchown: () => {}, stat, fstat: () => ({ uid: 1001, gid: 0 }) }), /owner could not be kept/);
  assert.deepStrictEqual(A.keepFileOwner(5, { ...o, getuid: () => 0, fchown: () => {}, stat, fstat: () => ({ uid: 1001, gid: 1002 }) }), { uid: 1001, gid: 1002 });
  // a temp file that already has the right owner needs no chown (filesystems that refuse chown keep working)
  assert.deepStrictEqual(A.keepFileOwner(5, { ...o, getuid: () => 0, fchown: () => { throw new Error('EPERM'); }, stat, fstat: () => ({ uid: 1001, gid: 1002 }) }), { uid: 1001, gid: 1002 });
  assert.strictEqual(A.keepFileOwner(5, { ...o, getuid: () => 1000, fchown: () => { throw new Error('EPERM'); }, stat }), null, 'not root: never chowns');
  const dir = fs.mkdtempSync(path.join(TMP, 'd-'));
  const user = A.createAuth({ dataDir: dir, log: () => {} });
  assert.ok(user.createUser({ login: 'one@example.com' }).ok);
  const before = fs.readFileSync(path.join(dir, 'users.json'), 'utf8');
  // as root the temp file starts root-owned (this test runs as an ordinary user, so fstat says so)
  const root = A.createAuth({ dataDir: dir, log: () => {}, getuid: () => 0, fchown: () => { throw new Error('EPERM'); }, fstat: () => ({ uid: 0, gid: 0 }) });
  assert.throws(() => root.createUser({ login: 'two@example.com' }), /owner could not be kept/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'), before, 'nothing was saved');
  assert.deepStrictEqual(fs.readdirSync(dir).filter(f => /\.tmp$/.test(f)), [], 'no temp file left');
});

test('r1 root: a change made as root chowns the temp file before the rename (injected getuid / fchown); not as root it never does', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'd-'));
  const calls = [];
  // as root the temp file starts root-owned and takes the owner fchown gives it (faked: this test runs as an ordinary user)
  let owner = { uid: 0, gid: 0 };
  const root = A.createAuth({ dataDir: dir, log: () => {}, getuid: () => 0, fstat: () => owner, fchown: (fd, uid, gid) => { owner = { uid, gid }; calls.push({ fd, uid, gid, tmpExists: fs.readdirSync(dir).some(f => /^\.users\..*\.tmp$/.test(f)), usersJson: fs.existsSync(path.join(dir, 'users.json')) }); } });
  const dirOwner = fs.statSync(dir);
  assert.ok(root.createUser({ login: 'one@example.com' }).ok);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual([calls[0].uid, calls[0].gid, calls[0].tmpExists, calls[0].usersJson], [dirOwner.uid, dirOwner.gid, true, false], 'no users.json yet: the data folder\'s owner');
  const fileOwner = fs.statSync(path.join(dir, 'users.json'));
  owner = { uid: 0, gid: 0 };
  assert.ok(root.createUser({ login: 'two@example.com' }).ok);
  assert.deepStrictEqual([calls[1].uid, calls[1].gid, calls[1].usersJson], [fileOwner.uid, fileOwner.gid, true], 'the existing file\'s owner');
  const plain = [];
  const user = A.createAuth({ dataDir: dir, log: () => {}, getuid: () => 1000, fchown: (...a) => plain.push(a) });
  assert.ok(user.createUser({ login: 'three@example.com' }).ok);
  assert.deepStrictEqual(plain, []);
  assert.strictEqual(root.listUsers().length, 3);
});

test('r2 root: as root on a data folder owned by someone else the command refuses with one line before opening or reading anything; no other line is printed', async () => {
  const st = (uid) => () => ({ uid });
  assert.strictEqual(CLI.rootOwnerNote({ getuid: () => 0, stat: st(1000) }), 'Run this without sudo, as the user that runs your Maestro (user id 1000).');
  assert.strictEqual(CLI.rootOwnerNote({ getuid: () => 0, stat: st(0) }), null);
  assert.strictEqual(CLI.rootOwnerNote({ getuid: () => 1000, stat: st(1000) }), null);
  assert.strictEqual(CLI.rootOwnerNote({ getuid: () => 0, stat: () => { throw new Error('x'); } }), null);
  const { hub } = fresh();
  hub.createUser({ login: 'person@example.com', password: OLD });
  const touched = [];
  const spy = new Proxy({}, { get: (_, k) => { touched.push(String(k)); return () => { throw new Error('touched'); }; } });
  const read = reader([NEW, NEW]);
  const r = await run('person@example.com', { a: spy, read, rootNote: () => 'Run this without sudo, as the user that runs your Maestro (user id 1000).' });
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(r.err, ['Run this without sudo, as the user that runs your Maestro (user id 1000).']);
  assert.deepStrictEqual(r.said, []);
  assert.deepStrictEqual(touched, [], 'the account store was not touched');
  assert.deepStrictEqual(read.prompts, [], 'no password was asked for');
  // reset-2fa as a real process cannot run as root here; its source checks before auth() is opened
  const src = fs.readFileSync(CLI_FILE, 'utf8');
  const i2 = src.indexOf("'reset-2fa'()");
  const body = src.slice(i2, src.indexOf("async 'reset-password'"));
  assert.ok(body.indexOf('rootOwnerNote()') > 0 && body.indexOf('rootOwnerNote()') < body.indexOf('auth()'), 'reset-2fa refuses before it opens the account store');
  assert.ok(!/out\(note\)/.test(body), 'the old "keeps its owner" line is not printed');
});

test('r1 sessions: a sign-in that verified the old password while a reset ran gets "Wrong login or password" and no session', () => {
  const { hub, mk, dir, file } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  hub.listUsers();
  const other = mk();
  const realOpen = fs.openSync;
  let fired = false;
  // the reset lands after login checked the old password and before its write (the first thing the write opens is the lock, or in old code the temp file)
  fs.openSync = function (p) {
    if (!fired && /users\.json\.lock$|\.users\.[0-9a-f]+\.tmp$/.test(String(p))) { fired = true; fs.openSync = realOpen; assert.ok(other.setPassword(u.id, NEW, { by: 'cli' }).ok); }
    return realOpen.apply(fs, arguments);
  };
  let r;
  try { r = hub.login('person@example.com', OLD); } finally { fs.openSync = realOpen; }
  assert.ok(fired);
  assert.deepStrictEqual(r, { ok: false, error: 'Wrong login or password' });
  assert.ok(!onDisk(file, u.id).lastLoginAt, 'no sign-in was recorded');
  assert.deepStrictEqual(dbRows(dir, 'SELECT id FROM sessions'), []);
  assert.strictEqual(hub.login('person@example.com', NEW).ok, true, 'the new password works');
});

test('r1 sessions: a sign-in is refused while the account is turned off', () => {
  const { hub, mk } = fresh();
  hub.createUser({ login: 'boss@example.com', role: 'admin', password: OLD });
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  hub.listUsers();
  const other = mk();
  const realOpen = fs.openSync;
  let fired = false;
  fs.openSync = function (p) {
    if (!fired && /users\.json\.lock$|\.users\.[0-9a-f]+\.tmp$/.test(String(p))) { fired = true; fs.openSync = realOpen; assert.ok(other.updateUser(u.id, { disabled: true }).ok); }
    return realOpen.apply(fs, arguments);
  };
  let r;
  try { r = hub.login('person@example.com', OLD); } finally { fs.openSync = realOpen; }
  assert.ok(fired);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'Wrong login or password');
});

test('r1 sessions: createSession throws when the account changed since the password was checked (new hash, turned off, deleted); a user without a hash skips the hash check', () => {
  const { hub, mk, dir } = fresh();
  hub.createUser({ login: 'boss@example.com', role: 'admin', password: OLD });
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  const w = hub.createUser({ login: 'other@example.com', password: OLD }).user;
  hub.listUsers();
  const checked = hub.getUser(u.id);   // what a sign-in holds: carries the old passwordHash
  assert.ok(checked.passwordHash);
  assert.ok(hub.createSession(checked).token, 'unchanged: fine');
  assert.ok(mk().setPassword(u.id, NEW, { by: 'cli' }).ok);
  assert.throws(() => hub.createSession(checked), /^Error: the account changed; sign in again$/);
  assert.deepStrictEqual(dbRows(dir, 'SELECT id FROM sessions WHERE user_id = ?', u.id), [], 'the reset also ended the earlier session, and no new one started');
  assert.ok(hub.createSession(hub.getUser(u.id)).token, 'with the current hash it works');
  assert.ok(hub.createSession({ id: u.id }).token, 'no hash on the passed user (a passkey): only the account is checked');
  assert.ok(hub.updateUser(w.id, { disabled: true }).ok);
  assert.throws(() => hub.createSession({ id: w.id }), /the account changed; sign in again/);
  assert.ok(hub.deleteUser(w.id).ok);
  assert.throws(() => hub.createSession({ id: w.id }), /the account changed; sign in again/);
  assert.throws(() => hub.createSession({ id: 'nobody' }), /the account changed; sign in again/);
});

test('r1 sessions: setPassword by another id ends the account\'s sessions after the write (a refused write ends none); by the person themselves it does not', () => {
  const { hub, mk, dir } = fresh();
  const a1 = hub.createUser({ login: 'one@example.com', password: OLD }).user;
  const count = () => dbRows(dir, 'SELECT id FROM sessions WHERE user_id = ?', a1.id).length;
  hub.createSession(a1); hub.createSession(a1);
  assert.strictEqual(count(), 2);
  // a failure at the write: the password is unchanged, so the sessions stay (R2: no revoke before the write)
  const cli = mk();
  const realOpen = fs.openSync;
  fs.openSync = function (p) { if (/users\.json\.lock$/.test(String(p))) throw new Error('simulated crash at the write'); return realOpen.apply(fs, arguments); };
  try { assert.throws(() => cli.setPassword(a1.id, NEW, { by: 'cli' }), /simulated crash/); } finally { fs.openSync = realOpen; }
  assert.strictEqual(count(), 2, 'a refused write signs nobody out');
  assert.ok(A.verifyPassword(OLD, hub.getUser(a1.id).passwordHash), 'and the password is unchanged');
  assert.ok(cli.setPassword(a1.id, NEW, { by: 'cli' }).ok);
  assert.strictEqual(count(), 0, 'revoked after the write');
  const a2 = hub.getUser(a1.id);
  // a session that starts while the reset is writing is ended after it
  fs.openSync = function (p) { if (/users\.json\.lock$/.test(String(p))) { fs.openSync = realOpen; hub.createSession(a2); } return realOpen.apply(fs, arguments); };
  try { assert.ok(cli.setPassword(a1.id, OLD, { by: 'cli' }).ok); } finally { fs.openSync = realOpen; }
  assert.strictEqual(count(), 0, 'revoked after the write');
  // the person changing their own password keeps their sessions
  hub.createSession(hub.getUser(a1.id));
  assert.ok(cli.setPassword(a1.id, NEW, { by: a1.id }).ok);
  assert.strictEqual(count(), 1);
});

test('r1 terminal: raw mode goes on before the prompt and stays on between the two prompts, a tab is kept, the signals restore the terminal and are removed afterwards', async () => {
  const { EventEmitter } = require('events');
  const fake = new EventEmitter();
  const events = [];
  fake.setRawMode = (on) => events.push(`raw:${on}`);
  fake.setEncoding = () => {}; fake.resume = () => events.push('resume'); fake.pause = () => events.push('pause');
  const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const realWrite = process.stdout.write;
  const prompts = ['New password: ', 'Type it again: '];
  process.stdout.write = function (s) { if (prompts.includes(String(s))) { events.push(`prompt:${String(s)}`); return true; } return realWrite.apply(process.stdout, arguments); };
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
  const sigs = ['SIGTERM', 'SIGHUP', 'SIGINT', 'SIGQUIT'];
  const before = sigs.map(s => process.listenerCount(s));
  try {
    const p1 = CLI.readHidden('New password: ');
    fake.emit('data', 'a\tb\u001b[Ac\r');
    assert.strictEqual(await p1, 'a\tbc');
    assert.deepStrictEqual(sigs.map(s => process.listenerCount(s)), before.map(n => n + 1), 'all four signals are handled while raw mode is on');
    const p2 = CLI.readHidden('Type it again: ');
    fake.emit('data', 'x\r');
    assert.strictEqual(await p2, 'x');
    assert.ok(!events.includes('raw:false'), 'raw mode was never turned off between the prompts');
    assert.ok(events.indexOf('raw:true') < events.indexOf('prompt:New password: '), 'raw mode is on before the first prompt is printed');
    assert.strictEqual(events.filter(e => e === 'raw:true').length, 1);
    CLI.endHidden();
    assert.ok(events.includes('raw:false'));
    assert.deepStrictEqual(sigs.map(s => process.listenerCount(s)), before, 'the handlers are removed afterwards');
  } finally {
    process.stdout.write = realWrite;
    Object.defineProperty(process, 'stdin', realStdin);
    CLI.endHidden();
  }
});

test('r1 server: every sign-in route checks that a session was made, so a reset during sign-in answers a failure instead of a 400 or a cookie', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(src, /catch \(e\) \{ if \(e && e\.message === 'the account changed; sign in again'\) return null; throw e; \}/);
  assert.strictEqual((src.match(/^\s*finishSignIn\(/gm) || []).length, 0, 'no route ignores the result');
  assert.strictEqual((src.match(/if \(!finishSignIn\(/g) || []).length, 3);
  assert.match(src, /if \(!finishSignIn\(r\.user, \{ totpOk: !r\.needsTotp \|\| trusted \}\)\) return jsonResponse\(res, 401, \{ ok: false, error: 'Wrong login or password' \}\);/);
  const A2 = require(path.join(ISO.inst, 'lib', 'auth'));
  const dir = fs.mkdtempSync(path.join(TMP, 'srv-'));
  const a = A2.createAuth({ dataDir: dir, now: () => T0, log: () => {} });
  const u = a.createUser({ login: 'sam@example.com', role: 'admin', password: OLD }).user;
  const r = a.login('sam@example.com', OLD);
  assert.strictEqual(r.ok, true);
  A2.createAuth({ dataDir: dir, now: () => T0, log: () => {} }).setPassword(u.id, NEW, { by: 'cli' });
  assert.throws(() => a.createSession(r.user), { message: 'the account changed; sign in again' });
});

// ── R2: a session is bound to the password it was made with ──
const credOfHash = (h) => require('crypto').createHash('sha256').update(String(h)).digest('hex').slice(0, 32);
const sessRow = (dir, id) => dbRows(dir, 'SELECT * FROM sessions WHERE id = ?', id)[0];
function rawDb(dir, fn) { const d = new Database(path.join(dir, 'auth.db')); try { return fn(d); } finally { d.close(); } }

test('r2 sessions: a session stores the digest of the password it was made with; the hash changed on disk with NO revoke ends it (row deleted)', () => {
  const { hub, dir, file } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  const s = hub.createSession(hub.getUser(u.id));
  assert.strictEqual(sessRow(dir, s.id).cred, credOfHash(onDisk(file, u.id).passwordHash));
  assert.ok(hub.getSession(s.token), 'valid while the password is the same');
  legacyWrite(file, (d) => { d.users.find(x => x.id === u.id).passwordHash = A.hashPassword(NEW); });   // no revoke at all (a crash between the hash and the revoke)
  assert.strictEqual(hub.getSession(s.token), null);
  assert.strictEqual(sessRow(dir, s.id), undefined, 'the row is gone');
});

test('r2 sessions: a session row inserted after the reset\'s revoke, carrying the old digest, is not valid; an account that is gone ends it too', () => {
  const { hub, mk, dir, file } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  const w = hub.createUser({ login: 'gone@example.com', password: OLD }).user;
  const s = hub.createSession(hub.getUser(u.id));
  const row = sessRow(dir, s.id);
  assert.ok(mk().setPassword(u.id, NEW, { by: 'cli' }).ok);   // the reset revokes
  assert.strictEqual(sessRow(dir, s.id), undefined);
  rawDb(dir, (d) => d.prepare('INSERT INTO sessions (id, user_id, created_at, last_seen, expires_at, ua, ip, totp_ok, cred) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(row.id, row.user_id, row.created_at, row.last_seen, new Date(Date.now() + 86400000).toISOString(), null, null, 0, row.cred));   // the late INSERT with the old digest
  assert.strictEqual(hub.getSession(s.token), null);
  assert.strictEqual(sessRow(dir, s.id), undefined, 'and the row is deleted');
  const s2 = hub.createSession(hub.getUser(w.id));
  legacyWrite(file, (d) => { d.users = d.users.filter(x => x.id !== w.id); });
  assert.strictEqual(hub.getSession(s2.token), null);
  assert.strictEqual(sessRow(dir, s2.id), undefined);
});

test('r2 sessions: a person changing their own password keeps their sessions; a reset by someone else ends them', () => {
  const { hub, mk, dir } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  const s1 = hub.createSession(hub.getUser(u.id)), s2 = hub.createSession(hub.getUser(u.id));
  assert.ok(mk().setPassword(u.id, NEW, { by: u.id }).ok);
  assert.ok(hub.getSession(s1.token) && hub.getSession(s2.token), 'both sessions stay signed in');
  assert.strictEqual(sessRow(dir, s1.id).cred, credOfHash(hub.getUser(u.id).passwordHash), 'with the new digest');
  assert.ok(mk().setPassword(u.id, OLD, { by: 'cli' }).ok);
  assert.strictEqual(hub.getSession(s1.token), null);
});

test('r2 sessions: a reset refused because users.json.lock is busy leaves the session valid', () => {
  const { hub, dir } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  const s = hub.createSession(hub.getUser(u.id));
  const lock = path.join(dir, 'users.json.lock');
  fs.writeFileSync(lock, 'someone else', { flag: 'wx' });
  try { assert.throws(() => hub.setPassword(u.id, NEW, { by: 'cli' }), /users\.json is busy/); } finally { fs.unlinkSync(lock); }
  assert.ok(hub.getSession(s.token), 'the password did not change, so nobody was signed out');
  assert.ok(A.verifyPassword(OLD, hub.getUser(u.id).passwordHash));
});

test('r2 sessions: createSession reads users.json fresh: an unreadable file means no session starts', () => {
  const { hub, dir, file } = fresh();
  const u = hub.createUser({ login: 'person@example.com', password: OLD }).user;
  hub.listUsers();
  const user = hub.getUser(u.id);
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => hub.createSession(user), /the account changed; sign in again/);
  assert.deepStrictEqual(dbRows(dir, 'SELECT id FROM sessions'), []);
});

test('r2 sessions: rows made before this change (cred NULL, also in an auth.db without the column) still work; a new person signs in with a session carrying the new digest', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'd-'));
  const first = A.createAuth({ dataDir: dir, now: () => T0, log: () => {} });
  const u = first.createUser({ login: 'person@example.com', password: OLD }).user;
  first.listUsers();
  // an auth.db from before: the sessions table without cred, one session in it
  fs.rmSync(path.join(dir, 'auth.db')); for (const x of ['-wal', '-shm']) fs.rmSync(path.join(dir, 'auth.db' + x), { force: true });
  const crypto = require('crypto');
  const old = new Database(path.join(dir, 'auth.db'));
  old.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT, last_seen TEXT, expires_at TEXT, ua TEXT, ip TEXT, totp_ok INTEGER DEFAULT 0)');
  old.prepare('INSERT INTO sessions (id, user_id, created_at, last_seen, expires_at) VALUES (?,?,?,?,?)').run(crypto.createHash('sha256').update('old-token').digest('hex'), u.id, 'x', 'x', new Date(T0 + 86400000).toISOString());
  old.close();
  const hub = A.createAuth({ dataDir: dir, now: () => T0, log: () => {} });
  const row = hub.getSession('old-token');
  assert.ok(row, 'the old session works');
  assert.strictEqual(row.cred, credOfHash(hub.getUser(u.id).passwordHash), 'a row from before is bound to the password its account has now');
  const cols = dbRows(dir, 'PRAGMA table_info(sessions)').map(c => c.name);
  assert.ok(cols.includes('cred'), 'the column was added');
  assert.ok(hub.setPassword(u.id, NEW, { by: u.id }).ok);
  assert.ok(hub.getSession('old-token'), 'changing your own password keeps your session from before the upgrade');
  // a reset cut short before its revoke (the new hash written, no revoke): the session from before the upgrade ends by itself
  const usersFile = path.join(dir, 'users.json');
  const data = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  data.users.find(x => x.id === u.id).passwordHash = A.hashPassword('a third password, set from the terminal');
  fs.writeFileSync(usersFile, JSON.stringify(data, null, 2));
  assert.strictEqual(hub.getSession('old-token'), null, 'the old session no longer works');
  assert.strictEqual(dbRows(dir, 'SELECT id FROM sessions WHERE user_id = ?', [u.id]).length, 0, 'and its row is gone');
  // a new person: the session made after the hash was written carries the new digest
  const n = hub.createUser({ login: 'new@example.com', password: OLD }).user;
  const s = hub.createSession(hub.getUser(n.id));
  assert.strictEqual(sessRow(dir, s.id).cred, credOfHash(hub.getUser(n.id).passwordHash));
  assert.ok(hub.getSession(s.token));
});

test('r2 lock: a stale lock that cannot be removed (EPERM) throws at once with the lock path, instead of looping until the deadline; ENOENT on the unlink is still fine', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'd-'));
  const lock = path.join(dir, 'users.json.lock');
  const mkA = (unlinkFile) => A.createAuth({ dataDir: dir, log: () => {}, unlinkFile });
  const u = mkA().createUser({ login: 'person@example.com', password: OLD }).user;
  fs.writeFileSync(lock, 'a process that stopped');
  const old = new Date(Date.now() - 20000); fs.utimesSync(lock, old, old);
  const t0 = Date.now();
  assert.throws(() => mkA(() => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; }).setPrefs(u.id, { theme: 'dark' }), (e) => e.message.includes(lock) && /could not be removed/.test(e.message));
  assert.ok(Date.now() - t0 < 1500, `ended at once (${Date.now() - t0} ms)`);
  assert.ok(fs.existsSync(lock), 'the lock is still there');
  // someone else took it over between the stat and the unlink: ENOENT is not an error
  const realUnlink = fs.unlinkSync;
  const ok = mkA((p) => { realUnlink(p); const e = new Error('gone'); e.code = 'ENOENT'; throw e; }).setPrefs(u.id, { theme: 'dark' });
  assert.ok(ok.ok);
});

test('r3 sessions: a users.json that cannot be read refuses the request but never deletes the session; once readable it works again', { skip: process.getuid && process.getuid() === 0 ? 'root reads any file' : false }, () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'd-'));
  const first = A.createAuth({ dataDir: dir, now: () => T0, log: () => {} });
  const u = first.createUser({ login: 'person@example.com', password: OLD }).user;
  const s = first.createSession(first.getUser(u.id));
  const file = path.join(dir, 'users.json');
  fs.chmodSync(file, 0o000);
  try {
    const fresh = A.createAuth({ dataDir: dir, now: () => T0, log: () => {} });   // its first read fails: it holds no accounts
    assert.strictEqual(fresh.getSession(s.token), null, 'the request is refused');
    assert.strictEqual(dbRows(dir, 'SELECT id FROM sessions WHERE id = ?', s.id).length, 1, 'the session row is kept');
  } finally { fs.chmodSync(file, 0o600); }
  const later = A.createAuth({ dataDir: dir, now: () => T0, log: () => {} });
  assert.ok(later.getSession(s.token), 'readable again: the session works');
});
