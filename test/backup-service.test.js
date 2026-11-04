'use strict';
// Backups for the running hub (lib/backup/service.js), the one place the server's routes use: refused before setup,
// one backup at a time, waiting for working agents unless "now"; extra folders checked; uploads checked and limited;
// names and upload ids validated; a restore prepared from an upload, checked against an admin sign-in from the backup,
// then confirmed (journal, then a restart) or cancelled; held items decided through the modules that own them.
// And the routes: admin only, the password asked again where it matters, the Welcome restore only before any account.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const Database = require('better-sqlite3');
const auth = require('../lib/auth');
const restore = require('../lib/backup/restore');
const recovery = require('../lib/backup/recovery');
const { ScheduledTasks } = require('../lib/scheduled-tasks');
const { createBackupService } = require('../lib/backup/service');
const { makeInstall, memSettings, w } = require('./helpers/backup-fixture');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-service-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const PW = 'service test passphrase';
const HUB = () => ({ version: '5.8.1', channel: 'experimental' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function serviceFor(inst, extra = {}) {
  const restarts = [];
  const settings = extra.settings || memSettings();
  const svc = createBackupService({ ...inst, platform: 'linux', settings, hubInfo: HUB, restart: (why) => restarts.push(why), ...extra });
  return { svc, settings, restarts };
}

test('backing up: refused before setup, waits for working agents unless now, one at a time, copied to extra folders', async () => {
  const inst = makeInstall(TMP, 'b1');
  let busy = ['degen'];
  const { svc, settings } = serviceFor(inst, { busyAgents: () => busy });
  assert.strictEqual(svc.status().key.configured, false);
  await assert.rejects(svc.backupNow({ now: true }), (e) => e.code === 'ENOKEY');
  const { recoveryKey } = await svc.setup(PW, { logN: 15 });
  assert.ok(recoveryKey && recoveryKey.length > 40);
  assert.deepStrictEqual(await svc.backupNow(), { waiting: true, working: ['degen'] }, 'waits while an agent works');
  const first = svc.backupNow({ now: true });
  await assert.rejects(svc.backupNow({ now: true }), (e) => e.code === 'EBUSY', 'one backup at a time');
  await assert.rejects(svc.confirmRestore({ id: 'x' }), (e) => e.code === 'EBUSY', 'no restore while a backup is being made');
  const r = await first;
  assert.strictEqual(r.done, true);
  assert.match(r.backup.name, /^my-maestro-ai-\d{4}-\d{2}-\d{2}-\d{4}\.age$/);
  assert.strictEqual(svc.running, null);
  assert.strictEqual(svc.status().last.name, r.backup.name);
  // Extra folders: full paths to folders that exist and can be written, nothing else
  assert.throws(() => svc.setFolders([{ dir: 'relative/folder' }]), /full path/);
  assert.throws(() => svc.setFolders([{ dir: path.join(TMP, 'no-such-folder') }]), /doesn't exist/);
  assert.throws(() => svc.setFolders('nope'), /list of folders/);
  const disk = path.join(TMP, 'b1-disk'); fs.mkdirSync(disk);
  assert.deepStrictEqual(svc.setFolders([{ dir: disk + '/', label: 'USB disk' }]).map(f => f.dir), [disk]);
  assert.strictEqual(settings.get().backup.folders[0].label, 'USB disk');
  assert.ok(settings.get().backup.key, 'the key settings stay beside the folders');
  busy = [];
  const r2 = await svc.backupNow();
  assert.strictEqual(r2.done, true);
  assert.notStrictEqual(r2.backup.name, r.backup.name, 'a second backup in the same minute gets its own name');
  assert.ok(fs.existsSync(path.join(disk, r2.backup.name)), 'copied to the extra folder');
  const names = (await svc.list()).map(b => b.name);
  assert.ok(names.includes(r.backup.name) && names.includes(r2.backup.name));
  assert.strictEqual(svc.filePath(r2.backup.name), path.join(inst.hubHome, 'backups', r2.backup.name));
});

test('setup only once (or replacing a lost key, listed as retiring); no backup folders inside My Maestro; uploads in pieces; a pause after wrong passwords', async () => {
  const inst = makeInstall(TMP, 'rules');
  const { svc, settings } = serviceFor(inst);
  await svc.setup(PW, { logN: 15 });
  const first = svc.status().key.keyId;
  await assert.rejects(svc.setup('another long passphrase', { logN: 15 }), (e) => e.code === 'EEXIST');
  await svc.setup('another long passphrase', { logN: 15, replace: true });
  assert.notStrictEqual(svc.status().key.keyId, first);
  assert.deepStrictEqual(svc.status().retiring.map(r => [r.keyId, r.lost]), [[first, true]], 'the lost key is listed as retiring');
  assert.strictEqual(svc.status().key.publicKey, undefined, 'the page is not handed the public key');
  for (const dir of [inst.root, path.join(inst.root, 'workspaces'), path.join(inst.hubHome, 'share'), path.join(inst.home, '.claude')]) {
    fs.mkdirSync(dir, { recursive: true });
    assert.throws(() => svc.setFolders([{ dir }]), /inside My Maestro's own folders/, dir);
  }
  assert.ok(settings.get().backup.key);
  // an upload in three pieces; a piece out of order or too big is refused
  await svc.backupNow({ now: true });
  const file = svc.filePath((await svc.list())[0].name);
  const all = fs.readFileSync(file), third = Math.ceil(all.length / 3);
  const p1 = await svc.acceptUpload(Readable.from([all.subarray(0, third)]), { expected: third, done: false });
  await assert.rejects(svc.acceptUpload(Readable.from([all.subarray(third)]), { uploadId: p1.uploadId, offset: third + 5, done: false }), (e) => e.code === 'EORDER');
  await svc.acceptUpload(Readable.from([all.subarray(third, 2 * third)]), { uploadId: p1.uploadId, offset: third, done: false });
  const p3 = await svc.acceptUpload(Readable.from([all.subarray(2 * third)]), { uploadId: p1.uploadId, offset: 2 * third, done: true });
  assert.deepStrictEqual([p3.uploadId, p3.size], [p1.uploadId, all.length]);
  assert.ok(p3.labels, 'the whole file arrived and its header reads');
  await assert.rejects(svc.acceptUpload(Readable.from([Buffer.alloc(1)]), { expected: 17 * 1024 * 1024 }), (e) => e.code === 'ETOOBIG');
  // five wrong backup passwords, then a pause (even for the right one)
  for (let i = 0; i < 5; i++) await assert.rejects(svc.recoveryKey({ password: `wrong guess number ${i}` }), (e) => e.code === 'EPASSWORD');
  await assert.rejects(svc.recoveryKey({ password: 'another long passphrase' }), (e) => e.code === 'ELOCKED');
});

test('names and upload ids are checked; uploads are checked, size-limited and leave nothing behind when refused', async () => {
  const inst = makeInstall(TMP, 'u1');
  const { svc } = serviceFor(inst);
  await svc.setup(PW, { logN: 15 });
  const made = await svc.backupNow({ now: true });
  const file = svc.filePath(made.backup.name);
  for (const name of ['../../etc/passwd', 'my-maestro-ai-2026-10-29-0000.age/../x', '', 'notes.txt']) {
    await assert.rejects(svc.prepareRestore({ name, password: PW }), (e) => e.code === 'ENOFILE', name);
  }
  assert.throws(() => svc.filePath('my-maestro-ai-2001-01-01-0000.age'), (e) => e.code === 'ENOFILE', 'a good name that is in no place');
  for (const uploadId of ['../x', 'A'.repeat(24), 'a'.repeat(25), 'a'.repeat(24)]) {
    await assert.rejects(svc.prepareRestore({ uploadId, password: PW }), (e) => e.code === 'ENOFILE', uploadId);
  }
  const dir = path.join(inst.root, '.restore', 'uploads');
  const up = await svc.acceptUpload(fs.createReadStream(file));
  assert.match(up.uploadId, /^[0-9a-f]{24}$/);
  assert.strictEqual(up.size, fs.statSync(file).size);
  assert.ok(up.keyId && up.labels, 'the labels are readable before the password');
  assert.strictEqual((fs.statSync(path.join(dir, `${up.uploadId}.age`)).mode & 0o777), 0o600);
  await assert.rejects(svc.acceptUpload(Readable.from([Buffer.from('hello, this is not a backup at all')])));
  await assert.rejects(svc.acceptUpload(fs.createReadStream(file), { limit: 1000 }), (e) => e.code === 'ENOSPC');
  await assert.rejects(svc.acceptUpload(Readable.from([Buffer.from('x')]), { limit: 1000, expected: 5000 }), (e) => e.code === 'ENOSPC');
  assert.deepStrictEqual(fs.readdirSync(dir), [`${up.uploadId}.age`], 'refused uploads leave no file');
});

test('a restore onto a fresh install: from an upload, an admin sign-in from the backup, then confirmed; cancelled before, not after', async () => {
  // The backed-up install has a real admin password and two-factor sign-in
  const inst = makeInstall(TMP, 'old');
  const D = (...p) => path.join(inst.root, 'data', ...p);
  const secret = auth.base32Encode(Buffer.from('0123456789abcdefghij'));
  const key = Buffer.from(fs.readFileSync(D('.auth-key'), 'utf8').trim(), 'hex');
  const users = JSON.parse(fs.readFileSync(D('users.json'), 'utf8'));
  users.users[0].passwordHash = auth.hashPassword('owner password 123');
  users.users[0].totp = { enabled: true, secretEnc: restore._test.aesEncrypt(key, secret) };
  users.users[1].passwordHash = auth.hashPassword('member password 123');
  fs.writeFileSync(D('users.json'), JSON.stringify(users));
  const { svc: oldSvc } = serviceFor(inst);
  const { recoveryKey } = await oldSvc.setup(PW, { logN: 15 });
  const file = oldSvc.filePath((await oldSvc.backupNow({ now: true })).backup.name);

  const target = { root: path.join(TMP, 'new-box', 'app'), home: path.join(TMP, 'new-box-home') };
  target.hubHome = path.join(target.root, 'hub-home');
  w(path.join(target.root, 'package.json'), JSON.stringify({ version: '5.8.1' }));
  w(path.join(target.root, '.env'), 'PORT=8888\n');
  const { svc, restarts } = serviceFor(target);
  const up = await svc.acceptUpload(fs.createReadStream(file));
  await assert.rejects(svc.prepareRestore({ uploadId: up.uploadId, password: 'wrong one', mode: 'fresh' }), (e) => e.code === 'EPASSWORD');
  const r = await svc.prepareRestore({ uploadId: up.uploadId, recoveryKey, mode: 'fresh' });
  const prepared = svc.status().prepared;
  assert.deepStrictEqual([prepared.id, prepared.backup, prepared.report], [r.id, r.backup, r.report], 'the facts for the warning, again after a reload');
  const no = (e) => e.code === 'ESIGNIN';
  assert.throws(() => svc.checkStagedAdmin({ login: 'owner@example.com', password: 'not it' }), no);
  assert.throws(() => svc.checkStagedAdmin({ login: 'owner@example.com', password: 'owner password 123' }), no, 'two-factor code needed');
  assert.throws(() => svc.checkStagedAdmin({ login: 'owner@example.com', password: 'owner password 123', code: '000000' }), no);
  assert.throws(() => svc.checkStagedAdmin({ login: 'old@example.com', password: 'member password 123' }), no, 'members are not enough');
  assert.throws(() => svc.checkStagedAdmin({ login: 'nobody@example.com', password: 'x' }), no);
  assert.deepStrictEqual(svc.checkStagedAdmin({ login: ' Owner@Example.com ', password: 'owner password 123', code: auth.totpCode(secret) }), { login: 'owner@example.com', name: null });

  // Cancel forgets it; prepare again, then confirm: a journal, then a restart, and no cancel any more
  assert.strictEqual(await svc.cancelRestore(), true);
  assert.strictEqual(svc.status().prepared, null);
  assert.ok(!fs.existsSync(path.join(target.root, '.restore', 'new')));
  const up2 = await svc.acceptUpload(fs.createReadStream(file));
  const r2 = await svc.prepareRestore({ uploadId: up2.uploadId, password: PW, mode: 'fresh' });
  await assert.rejects(svc.confirmRestore({ id: r.id }), (e) => e.code === 'ESTALE', 'only the restore that was checked');
  // a restore checked for a new install can't be confirmed once an account exists there
  let accounts = true;
  const { svc: svcB } = serviceFor(target, { hasAccounts: () => accounts });
  await assert.rejects(svcB.confirmRestore({ id: r2.id }), (e) => e.code === 'ESTALE' && /account exists now/.test(e.message));
  accounts = false;
  const c = await svc.confirmRestore({ id: r2.id });
  assert.strictEqual(c.id, r2.id);
  assert.ok(fs.existsSync(path.join(target.root, '.restore', 'journal.json')));
  await assert.rejects(svc.cancelRestore(), (e) => e.code === 'EBUSY');
  await sleep(400);
  assert.deepStrictEqual(restarts, ['restore a backup']);
});

test('held items after a restore are decided through the modules that own them', async () => {
  const root = path.join(TMP, 'held', 'app');
  const D = (...p) => path.join(root, 'data', ...p);
  const NOW = Date.parse('2026-10-29T14:00:00Z');
  w(D('scheduled-tasks.json'), JSON.stringify({ tasks: [
    { id: 'st-due', agent: 'degen', createdBy: 'degen', status: 'active', label: 'move $300', prompt: 'move it', schedule: { type: 'once', at: '2026-10-28T01:00:00Z' }, nextRunAt: '2026-10-28T01:00:00Z' },
    { id: 'st-late', agent: 'foreman', createdBy: 'foreman', status: 'active', label: 'nudge', prompt: 'nudge', schedule: { type: 'once', at: '2026-10-28T02:00:00Z' }, nextRunAt: '2026-10-28T02:00:00Z' },
    { id: 'st-future', agent: 'foreman', createdBy: 'foreman', status: 'active', prompt: 'later', schedule: { type: 'once', at: '2026-11-01T14:00:00Z' }, nextRunAt: '2026-11-01T14:00:00Z' },
  ], pending: [{ taskId: 'st-future', agent: 'foreman', dueAt: '2026-10-29T13:00:00Z', prompt: 'later' }] }));
  const db = new Database(D('task-queue.db'));
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, creator_agent TEXT NOT NULL, target_agent TEXT NOT NULL, trigger_type TEXT NOT NULL, trigger_value TEXT, action_prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT, execute_at TEXT, executed_at TEXT, result TEXT, error TEXT)");
  db.prepare("INSERT INTO tasks (creator_agent, target_agent, trigger_type, action_prompt) VALUES ('a','b','time','send the email'), ('a','c','time','pay invoice')").run();
  db.close();
  w(D('consult-queue.json'), JSON.stringify({ jobs: [{ id: 'cq-1', from: 'doc', to: 'gi', prompt: 'look at labs', key: 'k', depth: 1, ts: 1 }], mailbox: {} }));
  recovery.enter(root, { kind: 'restore', backup: { created: '2026-10-27T07:30:00Z' } }, () => NOW);

  // The real scheduler and a stand-in consultation queue
  const sched = new ScheduledTasks({ dataDir: D(), now: () => NOW, log: () => {} });
  const queued = [];
  const consultQ = { enqueue: (j) => { queued.push(j); return { ok: true, job: { id: 'cq-2', ...j } }; } };
  const { svc } = serviceFor({ root, hubHome: path.join(TMP, 'held'), home: path.join(TMP, 'held-home') }, { scheduled: () => sched, consult: () => consultQ });

  assert.throws(() => svc.decide('schedule:st-due', 'later'), /Run or Skip/);
  assert.throws(() => svc.decide('schedule:nope', 'run'), (e) => e.code === 'ENOITEM');
  assert.strictEqual(svc.decide('schedule:st-due', 'run').remaining, 5);
  assert.strictEqual(sched.tasks.get('st-due').status, 'active');
  assert.strictEqual(sched.tasks.get('st-due').nextRunAt, new Date(NOW).toISOString(), 'Run fires it at the next tick');
  svc.decide('schedule:st-late', 'skip');
  assert.strictEqual(sched.tasks.get('st-late').status, 'cancelled');
  svc.decide('delivery:st-future:2026-10-29T13:00:00Z', 'run');
  assert.deepStrictEqual(sched.pending.map(p => p.taskId), ['st-future'], 'the waiting delivery goes back in line');
  svc.decide('task:1', 'skip');
  svc.decide('task:2', 'run');
  const db2 = new Database(D('task-queue.db'), { readonly: true });
  assert.deepStrictEqual(db2.prepare('SELECT status, error FROM tasks ORDER BY id').all(), [{ status: 'failed', error: 'skipped after a restore' }, { status: 'pending', error: null }]);
  db2.close();
  svc.decide('consult:cq-1', 'run');
  assert.deepStrictEqual(queued.map(j => [j.from, j.to, j.prompt]), [['doc', 'gi', 'look at labs']]);
  const s = recovery.state(root);
  assert.deepStrictEqual(s.held, []);
  assert.deepStrictEqual(s.decided.map(d => [d.id, d.action]), [['schedule:st-due', 'run'], ['schedule:st-late', 'skip'], ['delivery:st-future:2026-10-29T13:00:00Z', 'run'], ['task:1', 'skip'], ['task:2', 'run'], ['consult:cq-1', 'run']]);
  assert.throws(() => svc.decide('task:1', 'run'), (e) => e.code === 'ENOITEM', 'decided once');
  // A consultation that can't be queued again stays held, with the reason
  recovery.enter(root, {}, () => NOW);
  w(D('consult-queue.json'), '{}');
  const s2 = recovery.state(root); s2.held.push({ id: 'consult:cq-9', kind: 'consult', item: { from: 'doc', to: 'doc', prompt: 'x' } });
  fs.writeFileSync(recovery.fileOf(root), JSON.stringify(s2));
  const { svc: svc2 } = serviceFor({ root, hubHome: path.join(TMP, 'held'), home: path.join(TMP, 'held-home') }, { consult: () => ({ enqueue: () => ({ ok: false, reason: 'an agent cannot queue a request to itself' }) }) });
  assert.throws(() => svc2.decide('consult:cq-9', 'run'), /could not be queued again: an agent cannot queue a request to itself/);
  assert.ok(recovery.state(root).held.some(h => h.id === 'consult:cq-9'));
});

test('a new backup password keeps the key; "it may have leaked" makes a new key, re-encrypts with a check, then retires the old one', async () => {
  const fmt = require('../lib/backup/format');
  const { pipeline } = require('stream/promises');
  const { Writable } = require('stream');
  const crypto = require('crypto');
  const inst = makeInstall(TMP, 'pw');
  const { svc, settings } = serviceFor(inst, { wrongMax: 100 });   // this test tries many wrong passwords on purpose
  const { recoveryKey: rk1 } = await svc.setup(PW, { logN: 15 });
  const disk = path.join(TMP, 'pw-disk'); fs.mkdirSync(disk);
  await svc.backupNow({ now: true });
  svc.setFolders([{ dir: disk }]);
  await svc.backupNow({ now: true });
  const files = () => [...fs.readdirSync(path.join(inst.hubHome, 'backups')).map(n => path.join(inst.hubHome, 'backups', n)), ...fs.readdirSync(disk).map(n => path.join(disk, n))].filter(f => f.endsWith('.age')).sort();
  // what a file decrypts to (sha256), or null when that secret doesn't open it
  const contentOf = async (file, unlock) => { const h = crypto.createHash('sha256'); try { await pipeline(fs.createReadStream(file), fmt.createDecryptStream({ unlock: fmt.unlockWith(unlock) }), new Writable({ write(c, _e, cb) { h.update(c); cb(); } })); return h.digest('hex'); } catch { return null; } };
  const before = {}; for (const f of files()) before[f] = await contentOf(f, { password: PW });
  assert.strictEqual(files().length, 3);
  assert.ok(Object.values(before).every(Boolean));

  // Change the password: the same key, every managed copy gets the new lock; the recovery key keeps working
  const PW2 = 'second backup passphrase';
  await assert.rejects(svc.changePassword({ password: 'not the password', newPassword: PW2, logN: 15 }), (e) => e.code === 'EPASSWORD');
  await assert.rejects(svc.changePassword({ password: PW, newPassword: 'short', logN: 15 }), (e) => e.code === 'EWEAK');
  const keyBefore = svc.status().key.keyId;
  const c = await svc.changePassword({ password: PW, newPassword: PW2, logN: 15 });
  assert.deepStrictEqual([c.rewritten, c.failed, c.unreachable], [3, [], []]);
  assert.strictEqual(svc.status().key.keyId, keyBefore, 'the same key');
  for (const f of files()) {
    assert.strictEqual(await contentOf(f, { password: PW2 }), before[f], 'opens with the new password, same content');
    assert.strictEqual(await contentOf(f, { password: PW }), null, 'not with the old one');
    assert.strictEqual(await contentOf(f, { recoveryKey: rk1 }), before[f], 'the recovery key still opens it');
  }
  const idx = require('../lib/backup/places').index(inst.root);
  for (const e of idx) { const f = path.join(inst.hubHome, 'backups', e.name); if (fs.existsSync(f)) assert.strictEqual(e.sha256, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'), 'the record follows the new bytes'); }
  assert.strictEqual((await svc.recoveryKey({ password: PW2 })).recoveryKey, rk1, 'the recovery key can be shown again with the password');
  await assert.rejects(svc.recoveryKey({ password: PW }), (e) => e.code === 'EPASSWORD');
  // one password check at a time (each costs 256 MiB for about a second at the real setting)
  const both = await Promise.allSettled([svc.recoveryKey({ password: PW2 }), svc.recoveryKey({ password: PW2 })]);
  assert.deepStrictEqual(both.map(x => x.status).sort(), ['fulfilled', 'rejected']);
  assert.strictEqual(both.find(x => x.status === 'rejected').reason.code, 'EBUSY');
  // forgot the password but kept the recovery key
  const PW3 = 'third backup passphrase';
  assert.strictEqual((await svc.changePassword({ recoveryKey: rk1, newPassword: PW3, logN: 15 })).rewritten, 3);
  for (const f of files()) assert.strictEqual(await contentOf(f, { password: PW3 }), before[f]);

  // The password may have leaked: a new key and recovery key first; nothing else changes until the second step
  const PW4 = 'fourth backup passphrase';
  await assert.rejects(svc.startRotation({ password: PW2, newPassword: PW4, logN: 15 }), (e) => e.code === 'EPASSWORD');
  const rot = await svc.startRotation({ password: PW3, newPassword: PW4, logN: 15 });
  assert.notStrictEqual(rot.recoveryKey, rk1);
  assert.strictEqual(rot.waiting, 3);
  assert.deepStrictEqual(svc.status().retiring.map(r => r.keyId), [keyBefore]);
  for (const f of files()) assert.strictEqual(await contentOf(f, { password: PW3 }), before[f], 'untouched until the second step');
  await assert.rejects(svc.finishRotation({ oldPassword: 'wrong old one', newPassword: PW4 }), (e) => e.code === 'EPASSWORD');
  await assert.rejects(svc.finishRotation({ oldPassword: PW3, newPassword: 'wrong new one' }), (e) => e.code === 'EPASSWORD');
  // a folder that can't be reached keeps the old key retiring
  fs.chmodSync(disk, 0o000);
  let f1;
  try { f1 = await svc.finishRotation({ oldPassword: PW3, newPassword: PW4 }); } finally { fs.chmodSync(disk, 0o700); }
  assert.deepStrictEqual([f1.reencrypted, f1.retired, f1.unreachable], [2, [], [disk]]);
  assert.deepStrictEqual(svc.status().retiring.map(r => r.keyId), [keyBefore], 'still retiring: the disk was away');
  const f2 = await svc.finishRotation({ oldRecoveryKey: rk1, newPassword: PW4 });
  assert.deepStrictEqual([f2.reencrypted, f2.retired, f2.failed], [1, [keyBefore], []]);
  assert.deepStrictEqual(svc.status().retiring, []);
  for (const f of files()) {
    assert.strictEqual(await contentOf(f, { password: PW4 }), before[f], 're-encrypted: the new password opens it, same content');
    assert.strictEqual(await contentOf(f, { recoveryKey: rot.recoveryKey }), before[f], 'and the new recovery key');
    assert.strictEqual(await contentOf(f, { password: PW3 }), null, 'the leaked password no longer does');
    assert.strictEqual(await contentOf(f, { recoveryKey: rk1 }), null, 'nor the old recovery key');
    assert.strictEqual((fs.statSync(f).mode & 0o777), 0o600);
  }
  assert.deepStrictEqual(fs.readdirSync(disk).filter(n => !n.endsWith('.age')), [], 'no leftover temporary files');
  const next = await svc.backupNow({ now: true });
  assert.strictEqual(await contentOf(svc.filePath(next.backup.name), { password: PW4 }) !== null, true, 'new backups use the new key');

  // Or delete them instead of re-encrypting
  const rot2 = await svc.startRotation({ password: PW4, newPassword: 'fifth backup passphrase', logN: 15 });
  assert.strictEqual(rot2.waiting, 5);
  await assert.rejects(svc.finishRotation({ action: 'delete' }), (e) => e.code === 'EPASSWORD', 'deleting needs the new backup password too');
  const d = await svc.finishRotation({ action: 'delete', newPassword: 'fifth backup passphrase' });
  assert.deepStrictEqual([d.deleted, d.retired.length], [5, 1]);
  assert.deepStrictEqual(files(), []);
  await assert.rejects(svc.finishRotation({ action: 'shred' }), /re-encrypt or delete/);
});

test('suggested passphrases: six words from the 7,776-word EFF list, picked at random, accepted as a backup password', () => {
  const { WORDS, suggestPassphrase } = require('../lib/backup/words');
  assert.strictEqual(WORDS.length, 7776);
  assert.strictEqual(new Set(WORDS).size, 7776);
  assert.ok(WORDS.every(w => /^[a-z-]+$/.test(w)));
  const seen = new Set();
  for (let i = 0; i < 50; i++) { const p = suggestPassphrase(); const parts = p.split(' '); assert.strictEqual(parts.length, 6); assert.ok(parts.every(w => WORDS.includes(w))); require('../lib/backup/keys').checkPassword(p); seen.add(p); }
  assert.strictEqual(seen.size, 50, 'no repeats in 50 draws');
  assert.ok(Math.log2(7776) * 6 > 77, 'about 77 bits');
});

test('the routes: admin only, the password asked again for restore, undo and downloads; the Welcome restore only before any account', () => {
  const access = require('../lib/access');
  for (const [p, m] of [['/api/backups', 'GET'], ['/api/backups/run', 'POST'], ['/api/backups/restore/confirm', 'POST'], ['/api/backups/file/' + 'a'.repeat(36), 'GET']]) {
    assert.strictEqual(access.classifyRoute(p, m).kind, 'admin', p);
  }
  for (const p of ['/api/welcome/restore/upload', '/api/welcome/restore/prepare', '/api/welcome/restore/confirm']) assert.strictEqual(access.classifyRoute(p, 'POST').kind, 'public', p);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = server.indexOf("if (pathname === '/api/backups' || pathname.startsWith('/api/backups/')) {");
  const welcomeAt = server.indexOf("if (pathname.startsWith('/api/welcome/restore/') && req.method === 'POST') {");
  assert.ok(start > 0 && welcomeAt > start);
  const block = server.slice(start, welcomeAt);
  assert.match(block, /^[^\n]*\n\s+if \(!access\.isAdmin\(req\.hubUser\) \|\| req\.hubPendingTotp\) return jsonResponse\(res, 403/, 'people only: no programs, no half-signed-in sessions');
  for (const route of ['restore/confirm', 'undo', 'download-link', 'password', 'rotate', 'recovery-key', 'setup', 'folders', 'rotate/finish']) {
    const at = block.indexOf(`pathname === '/api/backups/${route}'`);
    assert.ok(at > 0, route);
    assert.match(block.slice(at, block.indexOf('\n        if (', at + 10)), /const no = stepUp\(b\); if \(no\) return jsonResponse\(res, 403/, route);
  }
  assert.match(block, /if \(b\.confirm !== 'RESTORE'\) return jsonResponse\(res, 400/);
  assert.match(block, /if \(!t \|\| t\.until < Date\.now\(\) \|\| t\.user !== req\.hubUser\.id\)/, 'a download link is short-lived, used once and tied to its admin');
  // the generic settings routes neither show nor change backups
  assert.match(server, /const s = \{ \.\.\.hubSettings\.getForUI\(\) \}; delete s\.backup;/);
  assert.match(server, /if \(patch && typeof patch === 'object' && 'backup' in patch\) \{[^\n]*delete patch\.backup; \}/);
  // the rotation ticket is used up only by a finish that worked
  const fin = server.slice(server.indexOf("pathname === '/api/backups/rotate/finish'"), server.indexOf("pathname === '/api/backups/rotate/finish'") + 1200);
  assert.ok(fin.indexOf('rotationTickets.delete') > fin.indexOf('await svc.finishRotation('));
  const wel = server.slice(welcomeAt, welcomeAt + 2500);
  assert.match(wel, /if \(hubAuth\.hasUsers\(\)\) return jsonResponse\(res, 403/);
  assert.match(wel, /if \(hubAuth\.hasUsers\(\)\) return jsonResponse\(res, 403[^\n]*\n[^\n]*\n\s+if \(!welcome\.checkSetupToken\(String\(req\.headers\['x-setup-token'\] \|\| ''\)\)\) return jsonResponse\(res, 403/, 'the setup code, from a header, before any body is read, on every step');
  assert.match(wel, /checkStagedAdmin\(\{ login: b\.login, password: b\.password, code: b\.code \}\)[\s\S]{0,80}confirmRestore/);
});
