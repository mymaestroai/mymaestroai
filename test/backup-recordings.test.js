'use strict';
// Call recordings in backups, restores and undo (lib/backup/collect.js, restore.js, apply.js, recordings-merge.js): a backup
// holds them, a restore brings them back, and no restore or undo ever loses a session (live sessions the other side lacks are
// carried over, re-sealed when the install key differs).
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const keys = require('../lib/backup/keys');
const places = require('../lib/backup/places');
const { createBackup } = require('../lib/backup/create');
const restore = require('../lib/backup/restore');
const apply = require('../lib/backup/apply');
const { deriveKey } = require('../lib/recordings/crypt');
const { createStore } = require('../lib/recordings/store');
const { RECORDINGS, BACKUP_FOLDERS, FOLDERS } = require('../lib/hub-home');
const { makeInstall, memSettings } = require('./helpers/backup-fixture');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-recordings-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const PW = 'recordings test passphrase';

function wav(n = 160, rate = 8000) {
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'latin1'); b.write('fmt ', 12, 'latin1');
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36, 'latin1'); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE((i * 37) % 2000 - 1000, 44 + i * 2);
  return b;
}
const keyHex = (inst) => fs.readFileSync(path.join(inst.root, 'data', '.auth-key'), 'utf8').trim();
const storeOf = (inst, hex = keyHex(inst)) => createStore({ root: path.join(inst.hubHome, RECORDINGS), key: deriveKey(Buffer.from(hex, 'hex')) });
async function record(inst, agent = 'biographer', hex) {
  const s = storeOf(inst, hex);
  const { sessionId } = await s.createSession(agent, { userId: 'owner' });
  await s.addSegment(agent, sessionId, { speaker: 'person', wav: wav(), startedAt: new Date().toISOString() });
  await s.finish(agent, sessionId);
  return sessionId;
}
async function opens(inst, sid, hex, agent = 'biographer') {
  const s = storeOf(inst, hex);
  const m = await s.readManifest(agent, sid);
  assert.strictEqual(m.sessionId, sid);
  const flac = await s.readSegment(agent, sid, 1);
  assert.ok(flac.length > 4);
}
const hasSession = (inst, sid, agent = 'biographer') => fs.existsSync(path.join(inst.hubHome, RECORDINGS, agent, sid, 'manifest.json.enc'));

async function backupOf(name, { recordings = true } = {}) {
  const inst = makeInstall(TMP, name);
  const settings = memSettings();
  await keys.setup(PW, { settings, logN: 15 });
  const sid = recordings ? await record(inst) : null;
  const r = await createBackup({ ...inst, platform: 'linux', settings, places: [places.localPlace(inst.hubHome)], hub: { version: '5.8.1', channel: 'experimental' } });
  return { inst, file: r.places[0].file, sid };
}
async function restoreAndApply(inst, file) {
  const p = await restore.prepare({ file, password: PW, ...inst, platform: 'linux', mode: 'existing' });
  apply.confirm({ ...inst, platform: 'linux', id: p.id });
  const r = apply.applyAtBoot({ root: inst.root });
  assert.strictEqual(r.state, 'applied');
  return { prepared: p, applied: r };
}

test('hub-home: call-recordings is a backup folder but not one of the hub home folders', () => {
  assert.strictEqual(RECORDINGS, 'call-recordings');
  assert.deepStrictEqual(BACKUP_FOLDERS, [...FOLDERS, 'call-recordings']);
  assert.ok(!FOLDERS.includes(RECORDINGS));
});

test('a backup holds home/call-recordings, and prepare counts the sessions in the backup and live', async () => {
  const { inst, file, sid } = await backupOf('holds');
  const live = await record(inst);
  const p = await restore.prepare({ file, password: PW, ...inst, platform: 'linux', mode: 'existing' });
  const S = (...x) => path.join(inst.root, '.restore', 'new', 'home', RECORDINGS, ...x);
  assert.ok(fs.existsSync(S('.mymaestro-recordings')), 'the marker file is in the backup');
  assert.ok(fs.existsSync(S('biographer', sid, 'manifest.json.enc')));
  assert.ok(fs.existsSync(S('biographer', sid, '0001-person.flac.enc')));
  assert.deepStrictEqual(p.report.recordings, { inBackup: 1, live: 2 });
  assert.ok(live);
});

test('a link inside call-recordings is not followed into the backup', async () => {
  const inst = makeInstall(TMP, 'links');
  const settings = memSettings();
  await keys.setup(PW, { settings, logN: 15 });
  const sid = await record(inst);
  fs.writeFileSync(path.join(TMP, 'outside.txt'), 'secret');
  fs.symlinkSync(path.join(TMP, 'outside.txt'), path.join(inst.hubHome, RECORDINGS, 'biographer', sid, 'link.txt'));
  const r = await createBackup({ ...inst, platform: 'linux', settings, places: [places.localPlace(inst.hubHome)], hub: { version: '5.8.1' } });
  await restore.prepare({ file: r.places[0].file, password: PW, ...inst, platform: 'linux', mode: 'existing' });
  const staged = path.join(inst.root, '.restore', 'new', 'home', RECORDINGS, 'biographer', sid);
  assert.ok(fs.existsSync(path.join(staged, 'manifest.json.enc')));
  assert.ok(!fs.existsSync(path.join(staged, 'link.txt')), 'the link is left out');
});

test('restore onto an install with one more live session: both sessions are there and open with the restored key', async () => {
  const { inst, file, sid } = await backupOf('merge');
  const later = await record(inst);   // recorded after the backup
  const { applied } = await restoreAndApply(inst, file);
  assert.ok(hasSession(inst, sid) && hasSession(inst, later));
  await opens(inst, sid); await opens(inst, later);
  const rep = applied.journal.report.recordings;
  assert.strictEqual(rep.carried, 1);
  assert.strictEqual(rep.resealed, 0, 'same key: copied unchanged');
  assert.ok(fs.existsSync(path.join(inst.hubHome, RECORDINGS, '.mymaestro-recordings')));
  const aside = applied.journal.moves.find(m => m.live === path.join(inst.hubHome, RECORDINGS)).aside;
  assert.ok(fs.existsSync(path.join(aside, 'biographer', later, 'manifest.json.enc')), 'the live folder is set aside untouched');
  assert.strictEqual(fs.statSync(path.join(inst.hubHome, RECORDINGS)).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(path.join(inst.hubHome, RECORDINGS, 'biographer', later, 'manifest.json.enc')).mode & 0o777, 0o600);
});

test('a backup from another install key: the live-only session is re-sealed and opens with the restored key', async () => {
  const { inst, file, sid } = await backupOf('rekey');
  const oldHex = keyHex(inst);
  const newHex = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(inst.root, 'data', '.auth-key'), newHex);
  // today's recordings: the one from before, sealed with today's key, plus a new one
  fs.rmSync(path.join(inst.hubHome, RECORDINGS), { recursive: true, force: true });
  const mine = await record(inst, 'biographer', newHex);
  const { applied } = await restoreAndApply(inst, file);
  assert.strictEqual(keyHex(inst), oldHex, 'the restored key file');
  assert.ok(hasSession(inst, sid) && hasSession(inst, mine));
  await opens(inst, sid, oldHex); await opens(inst, mine, oldHex);
  await assert.rejects(opens(inst, mine, newHex), 'no longer sealed with the key that was replaced');
  const rep = applied.journal.report.recordings;
  assert.strictEqual(rep.carried, 1);
  assert.strictEqual(rep.resealed, 1);
  assert.deepStrictEqual(rep.notOpened, []);
});

test('the empty call marker in a session folder is copied unchanged across a key change and is not listed as unopened', async () => {
  const { callMarkerName } = require('../lib/recordings/store');
  const { inst, file } = await backupOf('marker');
  const oldHex = keyHex(inst);
  const newHex = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(inst.root, 'data', '.auth-key'), newHex);
  fs.rmSync(path.join(inst.hubHome, RECORDINGS), { recursive: true, force: true });
  const s = storeOf(inst, newHex);
  const { sessionId } = await s.createSession('biographer', { userId: 'owner', callId: 'call-marker-1' });
  await s.addSegment('biographer', sessionId, { speaker: 'person', wav: wav(), startedAt: new Date().toISOString() });
  const { applied } = await restoreAndApply(inst, file);
  assert.strictEqual(keyHex(inst), oldHex);
  const mk = path.join(inst.hubHome, RECORDINGS, 'biographer', sessionId, callMarkerName('call-marker-1'));
  assert.ok(fs.existsSync(mk), 'the marker is placed');
  assert.strictEqual(fs.statSync(mk).size, 0, 'unchanged: still empty');
  assert.deepStrictEqual(applied.journal.report.recordings.notOpened, []);
  await opens(inst, sessionId, oldHex);
});

test('a live file that does not open is copied unchanged and named in the report', async () => {
  const { inst, file } = await backupOf('broken');
  const oldHex = keyHex(inst);
  fs.writeFileSync(path.join(inst.root, 'data', '.auth-key'), crypto.randomBytes(32).toString('hex'));
  const dir = path.join(inst.hubHome, RECORDINGS, 'biographer', '20260101-000000-abcdef');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + path.sep + 'manifest.json.enc', 'not sealed at all');
  const { applied } = await restoreAndApply(inst, file);
  assert.ok(keyHex(inst) === oldHex);
  assert.strictEqual(fs.readFileSync(path.join(inst.hubHome, RECORDINGS, 'biographer', '20260101-000000-abcdef', 'manifest.json.enc'), 'utf8'), 'not sealed at all');
  assert.deepStrictEqual(applied.journal.report.recordings.notOpened, ['biographer/20260101-000000-abcdef/manifest.json.enc']);
});

test('a backup without call-recordings, restored onto an install with recordings, keeps them in place', async () => {
  const { inst, file } = await backupOf('none', { recordings: false });
  const mine = await record(inst);
  const { applied } = await restoreAndApply(inst, file);
  assert.ok(hasSession(inst, mine), 'still live');
  await opens(inst, mine);
  assert.strictEqual(applied.journal.report.recordings.carried, 1);
});

test('undo after a restore keeps a session recorded after the restore, re-sealed to the key that comes back', async () => {
  const { inst, file, sid } = await backupOf('undo');
  const oldHex = keyHex(inst);
  const todayHex = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(inst.root, 'data', '.auth-key'), todayHex);
  fs.rmSync(path.join(inst.hubHome, RECORDINGS), { recursive: true, force: true });
  const before = await record(inst, 'biographer', todayHex);
  await restoreAndApply(inst, file);
  assert.ok(apply.markHealthy({ root: inst.root }));
  const since = await record(inst, 'biographer', oldHex);   // after the restore, with the restored key
  apply.confirmUndo({ root: inst.root });
  const r = apply.applyAtBoot({ root: inst.root });
  assert.strictEqual(r.kind, 'undo');
  assert.strictEqual(keyHex(inst), todayHex, 'the previous key is back');
  assert.ok(hasSession(inst, before) && hasSession(inst, since));
  await opens(inst, before, todayHex); await opens(inst, since, todayHex);
  // the same merge as a restore: everything live but not in the folder put back (the session the restore brought, and the new one)
  assert.ok(hasSession(inst, sid)); await opens(inst, sid, todayHex);
  assert.strictEqual(r.journal.report.recordings.carried, 2);
  assert.strictEqual(r.journal.report.recordings.replacedByLive, 1, 'the session in both folders: today\'s copy is the one placed');
  assert.strictEqual(r.journal.report.recordings.resealed, 3, 'the two carried and the one that won a collision');
});

test('undo of a restore that brought recordings onto an install that had none keeps them live, with the sessions made since', async () => {
  const { inst, file, sid } = await backupOf('undo-none');
  fs.rmSync(path.join(inst.hubHome, RECORDINGS), { recursive: true, force: true });
  await restoreAndApply(inst, file);
  apply.markHealthy({ root: inst.root });
  const since = await record(inst);
  apply.confirmUndo({ root: inst.root });
  assert.strictEqual(apply.applyAtBoot({ root: inst.root }).kind, 'undo');
  assert.ok(hasSession(inst, since) && hasSession(inst, sid), 'nothing recorded is out of reach after an undo');
  await opens(inst, since);
});

test('running the carry-over again after a stop does not duplicate or half-copy', async () => {
  const { mergeRecordings } = require('../lib/backup/recordings-merge');
  const { inst } = await backupOf('twice');
  const live = path.join(inst.hubHome, RECORDINGS), staged = path.join(TMP, 'twice-staged');
  const k = Buffer.from('b'.repeat(64), 'hex');
  const a = mergeRecordings({ live, staged, liveInstallKey: k, stagedInstallKey: k });
  fs.mkdirSync(path.join(staged, 'biographer', '.merge-20260101-000000-abcdef', 'x'), { recursive: true });   // a crashed copy
  const b = mergeRecordings({ live, staged, liveInstallKey: k, stagedInstallKey: k });
  assert.strictEqual(a.carried, 1);
  assert.strictEqual(b.carried, 0);
  assert.deepStrictEqual(fs.readdirSync(path.join(staged, 'biographer')).length, 1, 'only the one session, no temporary copy');
});
