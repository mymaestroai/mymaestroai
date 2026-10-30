'use strict';
// Restoring, step one (lib/backup/restore.js prepare): open and check into a staging folder, then make it ready for
// this computer. Over an existing install: today's sign-ins, revocations and port are kept, accounts only in the
// backup come back disabled, kept two-factor secrets are re-locked with the restored key file, and what would be lost
// is counted. Onto a fresh install elsewhere with the recovery key: paths rewritten, the backup key taken from the
// file, automatic backups waiting for a new password. Refusals leave nothing behind.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const keys = require('../lib/backup/keys');
const places = require('../lib/backup/places');
const fmt = require('../lib/backup/format');
const { createBackup } = require('../lib/backup/create');
const restore = require('../lib/backup/restore');
const { makeInstall, memSettings, w, SID } = require('./helpers/backup-fixture');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-restore-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const PW = 'restore test passphrase';

async function backupOf(name, opts = {}) {
  const inst = makeInstall(TMP, name, opts);
  const settings = memSettings();
  const { recoveryKey } = await keys.setup(PW, { settings, logN: 15 });
  const r = await createBackup({ ...inst, platform: 'linux', settings, places: [places.localPlace(inst.hubHome)], hub: { version: '5.8.1', channel: 'experimental' } });
  return { inst, file: r.places[0].file, recoveryKey, settings };
}

test('over an existing install: today\'s sign-ins, revocations and port stay; backup-only accounts come back disabled; losses counted', async () => {
  const { inst, file } = await backupOf('existing');
  const D = (...p) => path.join(inst.root, 'data', ...p);
  // Things that happen after the backup
  const newKey = crypto.randomBytes(32);
  fs.writeFileSync(D('.auth-key'), newKey.toString('hex'));
  const totpLive = restore._test.aesEncrypt(newKey, 'JBSWY3DPEHPK3PXP');
  fs.writeFileSync(D('users.json'), JSON.stringify({ version: 1, users: [
    { id: 'u1', login: 'owner@example.com', role: 'admin', passwordHash: 'hash-changed-after-a-leak', totp: { secret: totpLive }, disabled: false },
    { id: 'u2', login: 'new@example.com', role: 'member', passwordHash: 'new-hash', disabled: false },
  ], invites: [] }));
  const adb = new Database(D('auth.db'));
  adb.prepare("UPDATE tokens SET revoked_at = '2026-10-29T10:00:00Z' WHERE id = 't1'").run();
  adb.prepare("DELETE FROM tokens WHERE id = 't2'").run();
  adb.prepare("INSERT INTO tokens (id, name, hash, scopes) VALUES ('t3', 'bot three', 'h3', 'chat')").run();
  adb.prepare("DELETE FROM sessions WHERE id = 's1'").run();   // signed out since the backup
  adb.prepare("INSERT INTO sessions (id, user_id, totp_ok) VALUES ('s2', 'u1', 1), ('s3', 'u2', 0), ('s4', 'u-gone', 1)").run();
  adb.prepare("INSERT INTO trusted (id, user_id) VALUES ('d1', 'u1')").run();
  adb.close();
  fs.appendFileSync(D('conversations', 'doc.jsonl'), 'a\nb\nc\n');
  fs.writeFileSync(D('agents.json'), JSON.stringify([{ name: 'doc' }, { name: 'a' }, { name: 'open' }, { name: 'homerepair' }]));
  w(path.join(inst.root, 'workspaces', 'doc', 'new-note.md'), 'written after the backup');
  fs.writeFileSync(path.join(inst.root, '.env'), 'PORT=9977\n');
  fs.writeFileSync(D('settings.json'), JSON.stringify({ backup: { folders: [{ dir: '/media/disk' }], key: { publicKey: 'today' } } }));

  const r = await restore.prepare({ file, password: PW, ...inst, platform: 'linux', mode: 'existing', working: ['degen'] });
  assert.strictEqual(r.report.keyStatus, 'other', 'today\'s settings hold a different key in this test');
  assert.strictEqual(r.mode, 'existing');
  const S = (...p) => path.join(inst.root, '.restore', 'new', ...p);
  const users = JSON.parse(fs.readFileSync(S('data', 'users.json'), 'utf8')).users;
  const u = (id) => users.find(x => x.id === id);
  assert.strictEqual(u('u1').passwordHash, 'hash-changed-after-a-leak', 'today\'s password kept');
  const stagedKey = Buffer.from(fs.readFileSync(S('data', '.auth-key'), 'utf8').trim(), 'hex');
  assert.strictEqual(restore._test.aesDecrypt(stagedKey, u('u1').totp.secret), 'JBSWY3DPEHPK3PXP', 'two-factor re-locked with the restored key file');
  assert.strictEqual(u('u0').disabled, true, 'an account deleted since comes back disabled');
  assert.strictEqual(u('u2').login, 'new@example.com', 'an account made since is kept');
  assert.deepStrictEqual(r.report.accounts, { kept: ['owner@example.com'], disabled: ['old@example.com'], added: ['new@example.com'] });
  const sdb = new Database(S('data', 'auth.db'), { readonly: true });
  const tok = Object.fromEntries(sdb.prepare('SELECT id, revoked_at FROM tokens').all().map(t => [t.id, t.revoked_at]));
  assert.strictEqual(tok.t1, '2026-10-29T10:00:00Z', 'revoked since: stays revoked');
  assert.ok(tok.t2, 'deleted since: revoked');
  assert.strictEqual(tok.t3, null, 'made since: kept');
  assert.deepStrictEqual(sdb.prepare('SELECT id, user_id, totp_ok FROM sessions ORDER BY id').all(), [{ id: 's2', user_id: 'u1', totp_ok: 1 }, { id: 's3', user_id: 'u2', totp_ok: 0 }], 'today\'s sign-ins stay (the one restoring is still signed in); the backup\'s old ones and strays go');
  assert.deepStrictEqual(sdb.prepare('SELECT id FROM trusted').all().map(t => t.id), ['d1'], 'trusted devices too');
  sdb.close();
  assert.match(fs.readFileSync(S('env', '.env'), 'utf8'), /^PORT=9977$/m, 'this install\'s port kept');
  assert.match(fs.readFileSync(S('env', '.env'), 'utf8'), /^OTHER=from-backup$/m);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(S('data', 'settings.json'), 'utf8')).backup, { folders: [{ dir: '/media/disk' }], key: { publicKey: 'today' } }, 'today\'s backup settings kept');
  // the link, read from where it will live
  const link = S('workspaces', 'doc', 'records', 'patient-a.md');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.strictEqual(path.resolve(path.join(inst.root, 'workspaces', 'doc', 'records'), fs.readlinkSync(link)), path.join(inst.hubHome, 'medical', 'patients', 'patient-a.md'));
  // permissions set by the hub
  assert.strictEqual(fs.statSync(S('data', 'settings.json')).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(S('data')).mode & 0o777, 0o700);
  // what would be lost
  assert.strictEqual(r.summary.messages, 3);
  assert.deepStrictEqual(r.summary.chatAgents, ['doc']);
  assert.deepStrictEqual(r.summary.agentsAdded, ['homerepair']);
  assert.ok(r.summary.newerFiles >= 1);
  assert.deepStrictEqual(r.workingNow, ['degen']);
  const prepared = JSON.parse(fs.readFileSync(path.join(inst.root, '.restore', 'prepared.json'), 'utf8'));
  assert.strictEqual(prepared.id, r.id);
  assert.strictEqual(prepared.fileSha256, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  assert.strictEqual(r.backup.version, '5.8.1');
  assert.strictEqual(r.backup.counts.agents, 3);
});

test('onto a fresh install in another folder, with the recovery key: paths rewritten, backup key from the file, a new password needed', async () => {
  const { inst, file, recoveryKey } = await backupOf('old-box');
  const target = { root: path.join(TMP, 'new-box', 'app'), home: path.join(TMP, 'new-box-home') };
  target.hubHome = path.join(target.root, 'hub-home');
  w(path.join(target.root, 'package.json'), JSON.stringify({ version: '5.9.0' }));
  w(path.join(target.root, '.env'), 'PORT=8888\n');
  const r = await restore.prepare({ file, recoveryKey, ...target, platform: 'linux', mode: 'fresh' });
  const S = (...p) => path.join(target.root, '.restore', 'new', ...p);
  const agents = JSON.parse(fs.readFileSync(S('data', 'agents.json'), 'utf8'));
  assert.deepStrictEqual(agents[0].policy.roots, [path.join(target.hubHome, 'medical')], 'folder grants follow the new home folder');
  assert.strictEqual(r.report.pathsRewritten, 1);
  const set = JSON.parse(fs.readFileSync(S('data', 'settings.json'), 'utf8'));
  const header = await fmt.readHeader(file);
  assert.strictEqual(set.backup.key.keyId, header.keyId);
  assert.strictEqual(set.backup.needsPassword, true, 'restored with the recovery key: automatic backups wait for a new password');
  assert.match(fs.readFileSync(S('env', '.env'), 'utf8'), /^PORT=8888$/m);
  const users = JSON.parse(fs.readFileSync(S('data', 'users.json'), 'utf8')).users;
  assert.strictEqual(users.find(x => x.id === 'u1').passwordHash, 'hash-at-backup', 'a fresh install signs in with the backup\'s accounts');
  const link = S('workspaces', 'doc', 'records', 'patient-a.md');
  assert.strictEqual(path.resolve(path.join(target.root, 'workspaces', 'doc', 'records'), fs.readlinkSync(link)), path.join(target.hubHome, 'medical', 'patients', 'patient-a.md'));
  assert.strictEqual(restore.finalPath(`external/claude/projects/${SID}.jsonl`, { ...target, platform: 'linux' }),
    path.join(target.home, '.claude', 'projects', target.root.replace(/[^a-zA-Z0-9]/g, '-'), `${SID}.jsonl`), 'the conversation is filed under the new folder');
  assert.strictEqual(restore.finalPath('external/claude/.credentials.json', { ...target, platform: 'darwin' }), null, 'a Linux sign-in is not written onto a Mac');
  assert.strictEqual(r.summary, null);
});

test('refusals leave nothing behind: a wrong password, a damaged file, a newer version, a restore already waiting', async () => {
  const { inst, file } = await backupOf('refuse');
  const target = { root: path.join(TMP, 'refuse-target'), home: path.join(TMP, 'refuse-target-home') };
  target.hubHome = path.join(target.root, 'hub-home');
  w(path.join(target.root, 'package.json'), JSON.stringify({ version: '5.8.1' }));
  const staged = () => fs.existsSync(path.join(target.root, '.restore', 'new')) || fs.existsSync(path.join(target.root, '.restore', 'prepared.json'));
  await assert.rejects(restore.prepare({ file, password: 'not the password', ...target, mode: 'fresh' }), (e) => e.code === 'EPASSWORD');
  assert.ok(!staged());
  const bad = path.join(TMP, 'bad.age'); const b = fs.readFileSync(file); b[b.length - 100] ^= 1; fs.writeFileSync(bad, b);
  await assert.rejects(restore.prepare({ file: bad, password: PW, ...target, mode: 'fresh' }), /cut off or damaged/);
  // cut off only at the very end (the last encrypted chunk): read on to the authenticated end, so this is caught too
  const tail = path.join(TMP, 'tail-cut.age'); const full = fs.readFileSync(file); fs.writeFileSync(tail, full.subarray(0, full.length - 7));
  await assert.rejects(restore.prepare({ file: tail, password: PW, ...target, mode: 'fresh' }), /cut off or damaged/);
  assert.ok(!fs.existsSync(path.join(target.root, '.restore', 'new')), 'and nothing is left staged');
  assert.ok(!staged());
  w(path.join(target.root, 'package.json'), JSON.stringify({ version: '5.7.3' }));
  await assert.rejects(restore.prepare({ file, password: PW, ...target, mode: 'fresh' }), (e) => e.code === 'ENEWER' && /newer than this install/.test(e.message));
  assert.ok(!staged());
  w(path.join(target.root, 'package.json'), JSON.stringify({ version: '5.8.1' }));
  w(path.join(target.root, '.restore', 'journal.json'), '{}');
  await assert.rejects(restore.prepare({ file, password: PW, ...target, mode: 'fresh' }), (e) => e.code === 'EBUSY');
  assert.ok(fs.existsSync(inst.root));
});

test('a crafted backup: forged with only the public key it is refused; with the origin key, the reader is still strict', async () => {
  const { inst, settings } = await backupOf('crafted');
  const zlib = require('zlib');
  const { pipeline } = require('stream/promises');
  const { Readable } = require('stream');
  const { tarStream } = require('../lib/backup/tar');
  async function craft(name, manifestEntries, tarEntries, { signed = true } = {}) {
    const key = keys.current({ settings });
    const manifest = Buffer.from(JSON.stringify({ format: 'my-maestro-backup', formatVersion: 1, created: new Date().toISOString(), hub: { version: '5.8.1' }, origin: {}, entries: manifestEntries }));
    const out = path.join(TMP, name);
    const origin = signed ? { macKey: key.originKey, manifestSha256: crypto.createHash('sha256').update(manifest).digest('hex') } : null;
    await pipeline(Readable.from(tarStream([{ path: 'manifest.json', type: 'file', data: manifest }, ...tarEntries])), zlib.createGzip(), fmt.createEncryptStream({ recipient: key.pub, stanzas: [key.envelope], origin }), fs.createWriteStream(out));
    return out;
  }
  const data = Buffer.from('x');
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  const target = { root: path.join(TMP, 'crafted-target'), home: path.join(TMP, 'crafted-home') };
  target.hubHome = path.join(target.root, 'hub-home');
  w(path.join(target.root, 'package.json'), JSON.stringify({ version: '5.8.1' }));
  const ok = [{ path: 'data', type: 'dir' }, { path: 'data/a', type: 'file', size: 1, sha256: sha }];
  const okTar = [{ path: 'data', type: 'dir' }, { path: 'data/a', type: 'file', data }];
  // Anyone who knows the public key can encrypt a file and copy the password stanza from a real backup: the owner's
  // password opens it, but it carries no proof of origin, so nothing is unpacked
  const forged = await craft('c0.age', ok, okTar, { signed: false });
  await assert.rejects(restore.prepare({ file: forged, password: PW, ...target, mode: 'fresh' }), (e) => e.code === 'EORIGIN');
  assert.ok(!fs.existsSync(path.join(target.root, '.restore', 'new')), 'nothing was unpacked');
  // Links: kept only to a file or folder of the backup; never to another link, never from workspaces/shared folders into data
  const f1 = await craft('c1.age',
    [...ok, { path: 'workspaces', type: 'dir' }, { path: 'workspaces/w', type: 'dir' }, { path: 'data/loop', type: 'link', target: 'data/loop' }, { path: 'data/l2', type: 'link', target: 'data/loop' }, { path: 'workspaces/w/peek', type: 'link', target: 'data/a' }, { path: 'workspaces/w/fine', type: 'link', target: 'workspaces/w' }],
    [...okTar, { path: 'workspaces', type: 'dir' }, { path: 'workspaces/w', type: 'dir' }, { path: 'data/loop', type: 'link', linkname: 'loop' }, { path: 'data/l2', type: 'link', linkname: 'loop' }, { path: 'workspaces/w/peek', type: 'link', linkname: '../../data/a' }, { path: 'workspaces/w/fine', type: 'link', linkname: '.' }]);
  const r = await restore.prepare({ file: f1, password: PW, ...target, mode: 'fresh' });
  assert.deepStrictEqual(r.report.linksDropped.map(l => l.path).sort(), ['data/l2', 'data/loop', 'workspaces/w/peek']);
  assert.ok(!fs.existsSync(path.join(target.root, '.restore', 'new', 'workspaces', 'w', 'peek')));
  assert.strictEqual((fs.statSync(path.join(target.root, '.restore', 'new', 'data', 'a')).mode & 0o777), 0o600, 'owner-only, whatever the archive said');
  await fs.promises.rm(path.join(target.root, '.restore'), { recursive: true, force: true });
  // A list naming a path outside its roots, or a link target that climbs out, is not a backup
  for (const [i, bad] of [[{ path: 'data/../../outside', type: 'link', target: 'data/a' }], [{ path: 'data/evil', type: 'link', target: '../../../../etc/passwd' }], [{ path: 'elsewhere/x', type: 'dir' }]].entries()) {
    const f = await craft(`cb${i}.age`, [...ok, ...bad], okTar);
    await assert.rejects(restore.prepare({ file: f, password: PW, ...target, mode: 'fresh' }), (e) => e.message === fmt.ERR.notBackup, JSON.stringify(bad));
  }
  const f2 = await craft('c2.age', [{ path: 'data', type: 'dir' }], [{ path: 'data', type: 'dir' }, { path: 'data/sneaky', type: 'file', data }]);
  await assert.rejects(restore.prepare({ file: f2, password: PW, ...target, mode: 'fresh' }), /its list doesn't name/);
  const f3 = await craft('c3.age', [{ path: 'data', type: 'dir' }, { path: 'data/a', type: 'file', size: 1, sha256: '0'.repeat(64) }], okTar);
  await assert.rejects(restore.prepare({ file: f3, password: PW, ...target, mode: 'fresh' }), /checksum/);
  const f4 = await craft('c4.age', [...ok, { path: 'data/l', type: 'link', target: 'data/a' }], okTar);
  await assert.rejects(restore.prepare({ file: f4, password: PW, ...target, mode: 'fresh' }), /missing something its list names/, 'a link the list names must be in the archive too');
  const f5 = await craft('c5.age', [...ok, { path: 'data/users.json', type: 'file', size: 1, sha256: sha }], [...okTar, { path: 'data/users.json', type: 'file', data }]);
  await assert.rejects(restore.prepare({ file: f5, password: PW, ...target, mode: 'fresh' }), /users\.json can't be read/);
  assert.ok(inst.root);
});
