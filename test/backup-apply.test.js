'use strict';
// Restoring, step two (lib/backup/apply.js): the journaled swap at start-up. A full restore and its undo; a crash
// (the process killed) after every single move, each finished at the next start; two failed starts rolled back;
// moves across disks; old set-aside copies pruned after the undo window.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const keys = require('../lib/backup/keys');
const places = require('../lib/backup/places');
const { createBackup } = require('../lib/backup/create');
const restore = require('../lib/backup/restore');
const apply = require('../lib/backup/apply');
const { makeInstall, memSettings, w } = require('./helpers/backup-fixture');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-apply-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const PW = 'apply test passphrase';
const read = (f) => fs.readFileSync(f, 'utf8');

// An install with a backup taken, then changed afterwards, and a restore prepared and confirmed.
async function ready(name) {
  const inst = makeInstall(TMP, name);
  const settings = memSettings();
  await keys.setup(PW, { settings, logN: 15 });
  const r = await createBackup({ ...inst, platform: 'linux', settings, places: [places.localPlace(inst.hubHome)], hub: { version: '5.8.1' } });
  w(path.join(inst.root, 'workspaces', 'doc', 'after.md'), 'made after the backup');
  fs.appendFileSync(path.join(inst.root, 'data', 'conversations', 'doc.jsonl'), 'later\n');
  w(path.join(inst.hubHome, 'share', 'common', 'f.txt'), 'changed after');
  w(path.join(inst.hubHome, 'legal', 'new.md'), 'a folder the backup does not have');
  const p = await restore.prepare({ file: r.places[0].file, password: PW, ...inst, platform: 'linux', mode: 'existing' });
  apply.confirm({ ...inst, platform: 'linux', id: p.id });
  return inst;
}
const restoredState = (inst) => {
  assert.ok(!fs.existsSync(path.join(inst.root, 'workspaces', 'doc', 'after.md')), 'a file made later is gone');
  assert.strictEqual(read(path.join(inst.root, 'data', 'conversations', 'doc.jsonl')).split('\n').filter(Boolean).length, 1);
  assert.strictEqual(read(path.join(inst.hubHome, 'share', 'common', 'f.txt')), 'shared');
  assert.ok(!fs.existsSync(path.join(inst.hubHome, 'legal')), 'a home folder the backup lacks is set aside');
  assert.strictEqual(read(path.join(inst.root, 'workspaces', 'doc', 'records', 'patient-a.md')), 'notes', 'the link works in place');
};
const changedState = (inst) => {
  assert.strictEqual(read(path.join(inst.root, 'workspaces', 'doc', 'after.md')), 'made after the backup');
  assert.strictEqual(read(path.join(inst.hubHome, 'share', 'common', 'f.txt')), 'changed after');
  assert.strictEqual(read(path.join(inst.hubHome, 'legal', 'new.md')), 'a folder the backup does not have');
};

test('a confirmed restore is carried out at the next start; healthy starts the undo clock; undo brings the previous setup back', async () => {
  const inst = await ready('full');
  const r = apply.applyAtBoot({ root: inst.root });
  assert.strictEqual(r.state, 'applied');
  restoredState(inst);
  assert.ok(!fs.existsSync(path.join(inst.root, '.restore', 'new')), 'the staged copy is used up');
  assert.ok(apply.markHealthy({ root: inst.root }));
  const last = apply.lastRestore({ root: inst.root });
  assert.ok(last.canUndo);
  assert.ok(fs.existsSync(path.join(last.aside, 'workspaces', 'doc', 'after.md')), 'today\'s setup is kept aside');
  apply.confirmUndo({ root: inst.root });
  assert.strictEqual(apply.applyAtBoot({ root: inst.root }).kind, 'undo');
  changedState(inst);
  apply.markHealthy({ root: inst.root });
  assert.strictEqual(apply.lastRestore({ root: inst.root }).canUndo, false, 'an undo is not undone again');
});

test('this computer\'s record of its backups and its nightly state carry across a restore and an undo', async () => {
  const inst = await ready('carry');
  const idx = JSON.parse(read(path.join(inst.root, 'data', 'backups.json')));
  w(path.join(inst.root, 'data', 'backup-schedule.json'), JSON.stringify({ lastDate: '2026-10-28', lastOkAt: '2026-10-28T07:30:00.000Z' }));
  assert.strictEqual(apply.applyAtBoot({ root: inst.root }).state, 'applied');
  assert.deepStrictEqual(JSON.parse(read(path.join(inst.root, 'data', 'backups.json'))), idx, 'the backups made here are still known (and tidied)');
  assert.strictEqual(JSON.parse(read(path.join(inst.root, 'data', 'backup-schedule.json'))).lastDate, '2026-10-28');
  assert.strictEqual(fs.statSync(path.join(inst.root, 'data', 'backups.json')).mode & 0o777, 0o600);
  apply.markHealthy({ root: inst.root });
  w(path.join(inst.root, 'data', 'backup-schedule.json'), JSON.stringify({ lastDate: '2026-10-29' }));
  apply.confirmUndo({ root: inst.root });
  apply.applyAtBoot({ root: inst.root });
  assert.strictEqual(JSON.parse(read(path.join(inst.root, 'data', 'backup-schedule.json'))).lastDate, '2026-10-29', 'the newest state wins on undo too');
  assert.deepStrictEqual(JSON.parse(read(path.join(inst.root, 'data', 'backups.json'))), idx);
});

test('a crash after any single move is finished at the next start', async () => {
  const inst0 = await ready('count');
  let total = 0;
  apply.applyAtBoot({ root: inst0.root, io: { renameSync: (a, b) => { fs.renameSync(a, b); total++; } } });
  restoredState(inst0);
  assert.ok(total >= 8, `${total} renames`);
  const crasher = path.join(TMP, 'crash.js');
  fs.writeFileSync(crasher, `const fs = require('fs'); const apply = require(${JSON.stringify(path.resolve(__dirname, '../lib/backup/apply'))});
    let n = 0; const limit = Number(process.argv[3]);
    const io = { renameSync: (a, b) => { fs.renameSync(a, b); if (++n === limit) process.exit(9); } };
    apply.applyAtBoot({ root: process.argv[2], io });`);
  for (let k = 1; k <= total; k++) {
    const inst = await ready(`crash-${k}`);
    const c = spawnSync(process.execPath, [crasher, inst.root, String(k)]);
    assert.strictEqual(c.status, 9, `the crash happened after move ${k}`);
    const r = apply.applyAtBoot({ root: inst.root });
    assert.strictEqual(r.state, 'applied', `finished after a crash at move ${k}`);
    restoredState(inst);
  }
});

test('two failed starts of the restored setup put the previous one back by itself', async () => {
  const inst = await ready('fails');
  assert.strictEqual(apply.applyAtBoot({ root: inst.root }).state, 'applied');   // first start: never reports healthy
  assert.strictEqual(apply.applyAtBoot({ root: inst.root }).state, 'applied');   // second start: same
  assert.strictEqual(apply.applyAtBoot({ root: inst.root }).state, 'rolled-back');
  changedState(inst);
  assert.ok(!fs.existsSync(path.join(inst.root, '.restore', 'journal.json')));
  assert.ok(fs.readdirSync(path.join(inst.root, '.restore')).some(n => /^rolled-back-/.test(n)));
  assert.strictEqual(apply.applyAtBoot({ root: inst.root }).state, 'none', 'and then starts normally');
});

test('moves across disks fall back to copying; a problem mid-way puts everything back', async () => {
  const inst = await ready('exdev');
  // placing from staging may cross disks (copied, flushed, renamed into place); setting aside never may
  const staged = path.join(inst.root, '.restore', 'new');
  let calls = 0;
  const io = { renameSync: (a, b) => { if (a.startsWith(staged) && ++calls <= 3) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); fs.renameSync(a, b); } };
  assert.strictEqual(apply.applyAtBoot({ root: inst.root, io }).state, 'applied');
  restoredState(inst);
  assert.ok(calls >= 3, 'three placements went by copy');
  // a set-aside move that would need a copy (the disks changed after confirming): refused, and nothing has moved yet
  const instX = await ready('exdev-aside');
  const ioX = { renameSync: (a, b) => { if (!a.startsWith(path.join(instX.root, '.restore', 'new'))) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); fs.renameSync(a, b); } };
  assert.strictEqual(apply.applyAtBoot({ root: instX.root, io: ioX, log: () => {} }).state, 'rolled-back');
  changedState(instX);
  // the same after two moves went fine: rolling back would need a copy too, so the start stops; the next one finishes
  const instY = await ready('exdev-later');
  let nY = 0;
  const ioY = { renameSync: (a, b) => { if (++nY > 2 && !a.startsWith(path.join(instY.root, '.restore', 'new'))) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); fs.renameSync(a, b); } };
  assert.throws(() => apply.applyAtBoot({ root: instY.root, io: ioY, log: () => {} }), (e) => e.code === 'EDISK');
  assert.strictEqual(apply.applyAtBoot({ root: instY.root, log: () => {} }).state, 'rolled-back', 'with the disks back, the interrupted roll-back finishes');
  changedState(instY);
  const inst2 = await ready('broken');
  let n = 0;
  const io2 = { renameSync: (a, b) => { if (++n === 5) throw Object.assign(new Error('disk said no'), { code: 'EIO' }); fs.renameSync(a, b); } };
  const r = apply.applyAtBoot({ root: inst2.root, io: io2, log: () => {} });
  assert.strictEqual(r.state, 'rolled-back');
  changedState(inst2);
});

test('a crash after any single move of a roll-back is finished at the next start', async () => {
  // count the renames of a roll-back after two failed starts
  const inst0 = await ready('rbcount');
  for (let i = 0; i < 2; i++) apply.applyAtBoot({ root: inst0.root });
  let total = 0;
  assert.strictEqual(apply.applyAtBoot({ root: inst0.root, io: { renameSync: (a, b) => { fs.renameSync(a, b); total++; } } }).state, 'rolled-back');
  changedState(inst0);
  assert.ok(total >= 8, `${total} renames`);
  const crasher = path.join(TMP, 'rbcrash.js');
  fs.writeFileSync(crasher, `const fs = require('fs'); const apply = require(${JSON.stringify(path.resolve(__dirname, '../lib/backup/apply'))});
    let n = 0; const limit = Number(process.argv[3]);
    const io = { renameSync: (a, b) => { fs.renameSync(a, b); if (++n === limit) process.exit(9); } };
    apply.applyAtBoot({ root: process.argv[2], io });`);
  for (let k = 1; k <= total; k++) {
    const inst = await ready(`rbcrash-${k}`);
    for (let i = 0; i < 2; i++) apply.applyAtBoot({ root: inst.root });
    const c = spawnSync(process.execPath, [crasher, inst.root, String(k)]);
    assert.strictEqual(c.status, 9, `the crash happened after roll-back move ${k}`);
    assert.strictEqual(apply.applyAtBoot({ root: inst.root, log: () => {} }).state, 'rolled-back', `roll-back finished after a crash at move ${k}`);
    changedState(inst);
  }
});

test('today\'s accounts win at the swap itself, and on undo; a missing staged copy rolls back instead of starting without it', async () => {
  const Database = require('better-sqlite3');
  const inst = await ready('late');
  const D = (...p) => path.join(inst.root, 'data', ...p);
  // after the restore was confirmed, before the restart: a password changed, a token revoked
  const users = JSON.parse(read(D('users.json'))); users.users[0].passwordHash = 'changed-after-confirm'; fs.writeFileSync(D('users.json'), JSON.stringify(users));
  const db = new Database(D('auth.db')); db.prepare("UPDATE tokens SET revoked_at = '2026-10-29T15:00:00Z', scopes = 'status' WHERE id = 't1'").run(); db.close();
  const r = apply.applyAtBoot({ root: inst.root });
  assert.strictEqual(r.state, 'applied');
  restoredState(inst);
  assert.strictEqual(JSON.parse(read(D('users.json'))).users.find(u => u.id === 'u1').passwordHash, 'changed-after-confirm');
  const db2 = new Database(D('auth.db'), { readonly: true });
  assert.deepStrictEqual(db2.prepare("SELECT revoked_at, scopes FROM tokens WHERE id = 't1'").get(), { revoked_at: '2026-10-29T15:00:00Z', scopes: 'status' }, 'today\'s token row');
  db2.close();
  // undo: the previous setup comes back with today's password
  apply.markHealthy({ root: inst.root });
  const u2 = JSON.parse(read(D('users.json'))); u2.users[0].passwordHash = 'changed-after-restore'; fs.writeFileSync(D('users.json'), JSON.stringify(u2));
  apply.confirmUndo({ root: inst.root });
  assert.strictEqual(apply.applyAtBoot({ root: inst.root }).kind, 'undo');
  changedState(inst);
  assert.strictEqual(JSON.parse(read(D('users.json'))).users.find(u => u.id === 'u1').passwordHash, 'changed-after-restore', 'undo keeps today\'s password');
  // a staged copy that went missing: never "placed", the swap rolls back
  const inst2 = await ready('missing');
  fs.rmSync(path.join(inst2.root, '.restore', 'new', 'workspaces'), { recursive: true });
  assert.strictEqual(apply.applyAtBoot({ root: inst2.root, log: () => {} }).state, 'rolled-back');
  changedState(inst2);
});

test('round 2: final journal states are filed at the next start; a folder the backup lacked comes back even if recreated; no second undo after a failed one', async () => {
  // a power cut between writing "healthy" and filing the journal away
  const a = await ready('filed');
  apply.applyAtBoot({ root: a.root });
  const jf = path.join(a.root, '.restore', 'journal.json');
  const j = JSON.parse(read(jf)); j.state = 'healthy'; j.healthyAt = new Date().toISOString(); fs.writeFileSync(jf, JSON.stringify(j));
  assert.strictEqual(apply.applyAtBoot({ root: a.root }).state, 'none');
  assert.ok(apply.lastRestore({ root: a.root }).canUndo, 'filed as the last restore');
  // the backup has no legal/ (made later); during the restored setup's failed starts something recreates it
  const b = await ready('recreated');
  apply.applyAtBoot({ root: b.root });
  w(path.join(b.hubHome, 'legal', 'recreated.md'), 'made by the restored setup');
  apply.applyAtBoot({ root: b.root }); apply.applyAtBoot({ root: b.root });
  assert.strictEqual(apply.applyAtBoot({ root: b.root }).state, 'none', 'rolled back on the third start, then normal');
  changedState(b);
  assert.ok(!fs.existsSync(path.join(b.hubHome, 'legal', 'recreated.md')), 'what the restored setup made is set aside, not mixed in');
  // an undo that fails twice is rolled back; the restore can't be undone again (its originals are no longer set aside)
  const c = await ready('undo-fails');
  apply.applyAtBoot({ root: c.root }); apply.markHealthy({ root: c.root });
  apply.confirmUndo({ root: c.root });
  for (let i = 0; i < 3; i++) apply.applyAtBoot({ root: c.root, log: () => {} });
  restoredState(c);
  assert.strictEqual(apply.lastRestore({ root: c.root }).canUndo, false);
  assert.throws(() => apply.confirmUndo({ root: c.root }), (e) => e.code === 'ENOUNDO');
  // today's backup key settings win at the swap (a key replaced after the restore was checked doesn't come back)
  const d = await ready('keys-today');
  const sf = path.join(d.root, 'data', 'settings.json'); const set = JSON.parse(read(sf)); set.backup = { key: { publicKey: 'today', keyId: 'feedfacefeedface' }, retired: [{ keyId: 'old' }] }; fs.writeFileSync(sf, JSON.stringify(set));
  apply.applyAtBoot({ root: d.root });
  assert.deepStrictEqual(JSON.parse(read(sf)).backup, set.backup);
  assert.ok(!fs.existsSync(path.join(d.root, '.restore', 'prepared.json')), 'a checked backup is confirmed only once');
});

test('a second restore within 7 days: the first one\'s set-aside copies are kept on record and removed when their 7 days are up', async () => {
  const inst = await ready('twice');
  apply.applyAtBoot({ root: inst.root }); apply.markHealthy({ root: inst.root });
  const first = apply.lastRestore({ root: inst.root });
  // a second restore of the same backup, a day later
  const settings = memSettings(); await keys.setup(PW, { settings, logN: 15 });
  const r = await createBackup({ ...inst, platform: 'linux', settings, places: [places.localPlace(inst.hubHome)], hub: { version: '5.8.1' } });
  const p = await restore.prepare({ file: r.places[0].file, password: PW, ...inst, platform: 'linux', mode: 'existing' });
  apply.confirm({ ...inst, platform: 'linux', id: p.id });
  apply.applyAtBoot({ root: inst.root }); apply.markHealthy({ root: inst.root });
  assert.notStrictEqual(apply.lastRestore({ root: inst.root }).id, first.id);
  const ledger = JSON.parse(read(path.join(inst.root, '.restore', 'asides.json')));
  assert.deepStrictEqual(ledger.entries.map(e => e.id), [first.id], 'the first restore\'s copies are on record');
  apply.prune(inst.root, () => Date.parse(first.healthyAt) + 3 * 86400000);
  assert.ok(fs.existsSync(first.aside), 'kept within its 7 days');
  apply.prune(inst.root, () => Date.parse(first.healthyAt) + 8 * 86400000);
  assert.ok(!fs.existsSync(first.aside), 'removed after them');
  assert.deepStrictEqual(JSON.parse(read(path.join(inst.root, '.restore', 'asides.json'))).entries, []);
});

test('round 3: no cleanup while a restore waits; staging judged by its age; undo records kept on record; set-aside copies only on the same disk', async () => {
  // an undo waiting for its start uses the restore's set-aside copies as its source: cleanup leaves them, even past 7 days
  const a = await ready('pending-undo');
  apply.applyAtBoot({ root: a.root }); apply.markHealthy({ root: a.root });
  const last = apply.lastRestore({ root: a.root });
  apply.confirmUndo({ root: a.root });
  apply.prune(a.root, () => Date.parse(last.healthyAt) + 8 * 86400000);
  assert.ok(fs.existsSync(last.aside), 'kept for the waiting undo');
  // a checked backup being unpacked right now (no prepared record yet) is left alone by the daily cleanup; at a start it goes
  const b = makeInstall(TMP, 'staging-age');
  w(path.join(b.root, '.restore', 'new', 'data', 'x'), 'being unpacked');
  apply.prune(b.root, () => Date.now());
  assert.ok(fs.existsSync(path.join(b.root, '.restore', 'new')), 'kept while it is fresh');
  apply.prune(b.root, () => Date.now() + 2 * 86400000);
  assert.ok(!fs.existsSync(path.join(b.root, '.restore', 'new')), 'removed after a day');
  w(path.join(b.root, '.restore', 'new', 'data', 'x'), 'left by a stopped process');
  apply.prune(b.root, () => Date.now(), { boot: true });
  assert.ok(!fs.existsSync(path.join(b.root, '.restore', 'new')), 'at a start it is a leftover');
  // restore, undo, restore again: the undo's record goes on the record of set-aside copies too
  const c = await ready('undo-then-restore');
  apply.applyAtBoot({ root: c.root }); apply.markHealthy({ root: c.root });
  apply.confirmUndo({ root: c.root }); apply.applyAtBoot({ root: c.root }); apply.markHealthy({ root: c.root });
  const undoRec = JSON.parse(read(path.join(c.root, '.restore', 'last-restore.json')));
  assert.strictEqual(undoRec.kind, 'undo');
  const settings = memSettings(); await keys.setup(PW, { settings, logN: 15 });
  const r = await createBackup({ ...c, platform: 'linux', settings, places: [places.localPlace(c.hubHome)], hub: { version: '5.8.1' } });
  const p = await restore.prepare({ file: r.places[0].file, password: PW, ...c, platform: 'linux', mode: 'existing' });
  apply.confirm({ ...c, platform: 'linux', id: p.id }); apply.applyAtBoot({ root: c.root }); apply.markHealthy({ root: c.root });
  assert.deepStrictEqual(JSON.parse(read(path.join(c.root, '.restore', 'asides.json'))).entries.map(e => e.id), [undoRec.id]);
  // a sign-in file on another disk (CLAUDE_CONFIG_DIR on a memory disk here) can't be set aside by a rename: refused at confirm
  if (fs.statSync('/dev/shm').dev !== fs.statSync(TMP).dev) {
    const d = makeInstall(TMP, 'other-disk');
    const settings2 = memSettings(); await keys.setup(PW, { settings: settings2, logN: 15 });
    const r2 = await createBackup({ ...d, platform: 'linux', settings: settings2, places: [places.localPlace(d.hubHome)], hub: { version: '5.8.1' } });
    const p2 = await restore.prepare({ file: r2.places[0].file, password: PW, ...d, platform: 'linux', mode: 'existing' });
    const shm = fs.mkdtempSync('/dev/shm/backup-apply-');
    process.env.CLAUDE_CONFIG_DIR = shm;
    try { assert.throws(() => apply.confirm({ ...d, platform: 'linux', id: p2.id }), (e) => e.code === 'EDISK'); }
    finally { delete process.env.CLAUDE_CONFIG_DIR; fs.rmSync(shm, { recursive: true, force: true }); }
    assert.ok(!fs.existsSync(path.join(d.root, '.restore', 'journal.json')), 'nothing was confirmed');
  }
});

test('a record of set-aside copies stays until they are really removed', async () => {
  const inst = await ready('stubborn');
  apply.applyAtBoot({ root: inst.root }); apply.markHealthy({ root: inst.root });
  const first = apply.lastRestore({ root: inst.root });
  const settings = memSettings(); await keys.setup(PW, { settings, logN: 15 });
  const r = await createBackup({ ...inst, platform: 'linux', settings, places: [places.localPlace(inst.hubHome)], hub: { version: '5.8.1' } });
  const p = await restore.prepare({ file: r.places[0].file, password: PW, ...inst, platform: 'linux', mode: 'existing' });
  apply.confirm({ ...inst, platform: 'linux', id: p.id }); apply.applyAtBoot({ root: inst.root }); apply.markHealthy({ root: inst.root });
  // something inside the first restore's copies can't be removed (a folder without write permission)
  const locked = path.join(first.aside, 'workspaces', 'doc'); fs.chmodSync(locked, 0o500);
  try { apply.prune(inst.root, () => Date.parse(first.healthyAt) + 8 * 86400000); } finally { fs.chmodSync(locked, 0o700); }
  assert.deepStrictEqual(JSON.parse(read(path.join(inst.root, '.restore', 'asides.json'))).entries.map(e => e.id), [first.id], 'kept on record to try again');
  apply.prune(inst.root, () => Date.parse(first.healthyAt) + 8 * 86400000);
  assert.ok(!fs.existsSync(first.aside));
  assert.deepStrictEqual(JSON.parse(read(path.join(inst.root, '.restore', 'asides.json'))).entries, []);
});

test('after the undo window, set-aside copies are removed at the next start', async () => {
  const inst = await ready('prune');
  apply.applyAtBoot({ root: inst.root });
  apply.markHealthy({ root: inst.root });
  const aside = apply.lastRestore({ root: inst.root }).aside;
  apply.applyAtBoot({ root: inst.root, now: () => Date.now() + 3 * 86400000 });
  assert.ok(fs.existsSync(aside), 'kept within 7 days');
  apply.applyAtBoot({ root: inst.root, now: () => Date.now() + 8 * 86400000 });
  assert.ok(!fs.existsSync(aside), 'removed after 7 days');
  assert.strictEqual(apply.lastRestore({ root: inst.root, now: () => Date.now() + 8 * 86400000 }).canUndo, false);
  assert.throws(() => apply.confirm({ ...inst, id: 'nope' }), (e) => e.code === 'ESTALE');
});
