'use strict';
// Data connector modules as backup places (lib/backup/module-places.js, and their use in create.js, places.js, service.js):
// the tools' answers are parsed and checked; a failed copy leaves no partial file; a backup is put to a module and checked;
// the list merges module copies; the keep rules, a restore, a password change and a key replacement reach them.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const keys = require('../lib/backup/keys');
const places = require('../lib/backup/places');
const restore = require('../lib/backup/restore');
const { createBackup, copyInto } = require('../lib/backup/create');
const { createBackupService } = require('../lib/backup/service');
const { createModulePlaces, readInstallId } = require('../lib/backup/module-places');
const { makeInstall, memSettings } = require('./helpers/backup-fixture');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-module-places-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const NAME = 'my-maestro-ai-2026-10-01-0330.age';
const MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
const NY = 'America/New_York';
const INSTALL = '0123456789abcdef';
const FID = 'drive-file-1';
const text = (o) => JSON.stringify(o);
const mcp = (o, isError = false) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : text(o) }], isError });
const md5Of = (file) => crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');

// a module place over a fake callTool; `answers[tool]` is what it returns (or a function of the args)
function placesWith(answers, extra = {}) {
  const calls = [];
  const connectors = { callTool: async (id, tool, args, o) => { calls.push({ id, tool, args, o }); const a = answers[tool]; let r = typeof a === 'function' ? a(args) : a; if (r && typeof r === 'object' && !r.content && !(r instanceof Error)) r = JSON.stringify(r); if (r instanceof Error) throw r; return r; } };
  return { mp: createModulePlaces({ modules: { backupModules: () => [{ id: 'drive', label: 'Google Drive' }] }, connectors, installId: () => INSTALL, ...extra }), calls };
}

// an in-memory module with the four operations, for the places tests
function fakeModule({ label = 'Google Drive', id = 'drive' } = {}) {
  const store = new Map();
  let seq = 0;
  const m = {
    store, failList: false, failPut: false, lie: null, putCalls: [], removed: [], removedIds: [], getCalls: [],
    places: () => [{ kind: 'module', id, label }],
    async put(i, file, name) { m.putCalls.push({ i, file, name }); if (m.failPut) throw new Error('Drive is full'); const b = fs.readFileSync(file); const fid = `fid-${++seq}`; store.set(name, { bytes: b, created: new Date().toISOString(), id: fid }); return { name, size: m.lie != null ? m.lie : b.length, md5: crypto.createHash('md5').update(b).digest('hex'), id: fid }; },
    async list() { if (m.failList) throw new Error('offline'); return [...store].map(([name, v]) => ({ name, size: v.bytes.length, created: v.created, id: v.id })); },
    async remove(i, name, fileId) { m.removed.push(name); m.removedIds.push(fileId); const v = store.get(name); if (!v || v.id !== fileId) return false; return store.delete(name); },
    async get(i, name, out, fileId) { m.getCalls.push({ name, fileId }); const v = store.get(name); fs.writeFileSync(out, v.bytes); return { size: v.bytes.length, md5: m.badMd5 ? MD5 : crypto.createHash('md5').update(v.bytes).digest('hex') }; },
  };
  return m;
}

test('module places: places() lists the finished, switched-on backup modules, and never throws', () => {
  const { mp } = placesWith({});
  assert.deepStrictEqual(mp.places(), [{ kind: 'module', id: 'drive', label: 'Google Drive' }]);
  assert.deepStrictEqual(createModulePlaces({ modules: { backupModules: () => { throw new Error('boom'); } }, connectors: {} }).places(), []);
});

test('module places: put/list/remove/get accept a string or an MCP result, call with the time limit, and check every shape', async () => {
  const { mp, calls } = placesWith({
    backup_put: (a) => ({ name: a.name, size: 10, md5: MD5, id: FID }),
    backup_list: mcp({ files: [{ name: NAME, size: 5, created: '2026-10-01T07:30:00Z', id: FID }, { name: 'notes.txt', size: 1 }, { name: NAME.replace('10-01', '10-02'), size: -1 }] }),
    backup_delete: text({ deleted: true }),
    backup_get: mcp({ size: 7, md5: MD5.toUpperCase() }),
  }, { timeoutMs: 1234 });
  assert.deepStrictEqual(await mp.put('drive', '/x/f.age', NAME), { name: NAME, size: 10, md5: MD5, id: FID });
  assert.deepStrictEqual(calls[0], { id: 'drive', tool: 'backup_put', args: { file: '/x/f.age', name: NAME, install: INSTALL }, o: { timeoutMs: 1234, hub: true } });
  assert.deepStrictEqual(await mp.list('drive'), [{ name: NAME, size: 5, created: '2026-10-01T07:30:00Z', id: FID }], 'only well-formed names and sizes');
  assert.deepStrictEqual(calls[1].args, { install: INSTALL });
  assert.strictEqual(await mp.remove('drive', NAME, FID), true);
  assert.deepStrictEqual(calls[2].args, { name: NAME, id: FID, install: INSTALL });
  assert.deepStrictEqual(await mp.get('drive', NAME, '/x/out.age', FID), { size: 7, md5: MD5 });
  assert.deepStrictEqual(calls[3].args, { name: NAME, id: FID, out: '/x/out.age', install: INSTALL });
  assert.ok(calls.every(c => c.o.hub === true), 'every call carries the hub flag');
});

test('module places: a failure, an error result, bad JSON and bad shapes are plain errors', async () => {
  const bad = async (answers, fn, re) => { const { mp } = placesWith(answers); await assert.rejects(fn(mp), re); };
  await bad({ backup_put: new Error('timed out') }, (m) => m.put('drive', '/f', NAME), /backup_put failed: timed out/);
  await bad({ backup_put: mcp('Drive is full', true) }, (m) => m.put('drive', '/f', NAME), /Drive is full/);
  await bad({ backup_put: 'not json' }, (m) => m.put('drive', '/f', NAME), /did not answer with JSON/);
  await bad({ backup_put: '[1]' }, (m) => m.put('drive', '/f', NAME), /wrong shape/);
  await bad({ backup_put: undefined }, (m) => m.put('drive', '/f', NAME), /no answer/);
  await bad({ backup_put: { name: NAME, size: 1, md5: MD5 } }, (m) => m.put('drive', '/f', NAME), /where it stored/);
  await bad({ backup_put: { name: NAME, size: 1, md5: MD5, id: '' } }, (m) => m.put('drive', '/f', NAME), /where it stored/);
  await bad({ backup_put: { name: NAME, size: 1, md5: MD5, id: 'x'.repeat(201) } }, (m) => m.put('drive', '/f', NAME), /where it stored/);
  await bad({ backup_put: { name: NAME, size: -1, md5: MD5, id: FID } }, (m) => m.put('drive', '/f', NAME), /how big/);
  await bad({ backup_put: { name: NAME, size: 1.5, md5: MD5, id: FID } }, (m) => m.put('drive', '/f', NAME), /how big/);
  await bad({ backup_put: { name: NAME, size: 1, md5: 'xyz', id: FID } }, (m) => m.put('drive', '/f', NAME), /checksum/);
  await bad({ backup_put: { name: 'other.age', size: 1, md5: MD5, id: FID } }, (m) => m.put('drive', '/f', NAME), /another name/);
  await bad({}, (m) => m.put('drive', '/f', '../evil.age'), /not a backup name/);
  await bad({ backup_list: { files: 'x' } }, (m) => m.list('drive'), /wrong shape/);
  await bad({ backup_delete: { deleted: 'yes' } }, (m) => m.remove('drive', NAME), /wrong shape/);
  await bad({ backup_get: { size: 3 } }, (m) => m.get('drive', NAME, '/o'), /checksum/);
});

test('the install id is made once (16 hex, 0600) under data/ and reused', () => {
  const root = path.join(TMP, 'install-id-root'); fs.mkdirSync(root);
  const a = readInstallId(root);
  assert.match(a, /^[0-9a-f]{16}$/);
  const file = path.join(root, 'data', 'install-id');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(readInstallId(root), a);
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim(), a);
  // through a module place with the real reader: the same id on every call
  const seen = [];
  const mp = createModulePlaces({ root, modules: { backupModules: () => [] }, connectors: { callTool: async (id, tool, args) => { seen.push(args.install); return '{"files":[]}'; } } });
  return mp.list('drive').then(() => mp.list('drive')).then(() => assert.deepStrictEqual(seen, [a, a]));
});

test('copyInto removes its .partial when the copy fails', async () => {
  // a source that does not exist: the write stream has opened the partial by then
  const dir = path.join(TMP, 'copy-fail'); fs.mkdirSync(dir);
  await assert.rejects(copyInto(path.join(TMP, 'no-such-file'), dir, NAME));
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

async function backupWith(name, mod, { extra = [], places: more } = {}) {
  const inst = makeInstall(TMP, name);
  const settings = memSettings();
  await keys.setup('a strong test passphrase', { settings, logN: 15 });
  const target = more || [{ kind: 'module', id: 'drive', label: 'Google Drive' }];
  const r = await createBackup({ ...inst, platform: 'linux', _holdBoxes: () => () => {}, settings, hub: { version: '5.8.1' }, places: [places.localPlace(inst.hubHome), ...target], modulePlaces: mod });
  return { inst, r, settings };
}

test('a backup is put to a module and checked: recorded when it matches, an error recorded (local copy kept) when it does not or the put fails', async () => {
  const ok = fakeModule();
  const a = await backupWith('mod-ok', ok);
  assert.deepStrictEqual(a.r.places[1], { kind: 'module', id: 'drive', label: 'Google Drive', name: a.r.name, size: a.r.size, fileId: 'fid-1', keyId: places.index(a.inst.root)[0].keyId });
  assert.match(places.index(a.inst.root)[0].md5, /^[0-9a-f]{32}$/, 'the record keeps the md5 beside the sha256');
  assert.strictEqual(ok.putCalls[0].file, a.r.places[0].file, 'the module reads the local file');
  assert.strictEqual(md5Of(a.r.places[0].file), crypto.createHash('md5').update(ok.store.get(a.r.name).bytes).digest('hex'));
  assert.deepStrictEqual(places.index(a.inst.root)[0].places, a.r.places, 'the record keeps it');

  const wrong = fakeModule(); wrong.lie = 3;
  const b = await backupWith('mod-size', wrong);
  assert.match(b.r.places[1].error, /stored 3 bytes/); assert.ok(!('name' in b.r.places[1]));
  assert.ok(fs.existsSync(b.r.places[0].file));

  const mismatch = fakeModule(); const put = mismatch.put;
  mismatch.put = async (...a2) => ({ ...(await put(...a2)), md5: MD5 });
  const c = await backupWith('mod-md5', mismatch);
  assert.match(c.r.places[1].error, /does not match/);

  const down = fakeModule(); down.failPut = true;
  const d = await backupWith('mod-down', down);
  assert.deepStrictEqual([d.r.places[1].kind, d.r.places[1].error], ['module', 'Drive is full']);
  assert.ok(fs.existsSync(d.r.places[0].file), 'the local copy is kept');
  assert.strictEqual(d.r.places.length, 2);
});

test('list() merges a module copy with the others by name; one that fails to list is skipped', async () => {
  const mod = fakeModule();
  const a = await backupWith('mod-list', mod, { places: [places.folderPlace(path.join(TMP, 'mod-list-folder')), { kind: 'module', id: 'drive', label: 'Google Drive' }] });
  const all = [places.localPlace(a.inst.hubHome), { kind: 'module', id: 'drive', label: 'Google Drive' }];
  const l = await places.list(a.inst.root, all, mod);
  assert.strictEqual(l.length, 1);
  const w = l[0].places.find(p => p.kind === 'module');
  assert.deepStrictEqual(w, { kind: 'module', id: 'drive', label: 'Google Drive', size: a.r.size, fileId: 'fid-1', readable: true, keyId: places.index(a.inst.root)[0].keyId });
  assert.strictEqual(l[0].places.length, 2);
  mod.store.get(a.r.name).bytes = Buffer.alloc(5);   // a different size: not this hub's copy as written
  const w2 = (await places.list(a.inst.root, all, mod))[0].places.find(p => p.kind === 'module');
  assert.deepStrictEqual([w2.readable, w2.keyId], [false, null]);
  mod.failList = true;
  assert.strictEqual((await places.list(a.inst.root, all, mod))[0].places.length, 1);
});

function nightly(inst, mod, days) {
  const local = path.join(inst.hubHome, 'backups'); fs.mkdirSync(local, { recursive: true });
  const names = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(2026, 9, 1 + i, 7, 30)), name = `my-maestro-ai-2026-10-${String(i + 1).padStart(2, '0')}-0330.age`;
    names.push(name);
    fs.writeFileSync(path.join(local, name), Buffer.alloc(64, 1));
    mod.store.set(name, { bytes: Buffer.alloc(64, 1), created: d.toISOString(), id: `fid-${name}` });
    places.recordInIndex(inst.root, { id: name.replace(/\.age$/, ''), name, created: d.toISOString(), size: 64, reason: 'nightly', places: [{ kind: 'local', dir: local, file: path.join(local, name) }, { kind: 'module', id: 'drive', label: 'Google Drive', name, size: 64, fileId: `fid-${name}` }] });
  }
  return names;
}

test('keep rules: old module copies are deleted, a changed one is left, and a module that fails to list is away', async () => {
  const inst = makeInstall(TMP, 'mod-keep');
  const mod = fakeModule();
  const names = nightly(inst, mod, 6);
  mod.store.get(names[0]).bytes = Buffer.alloc(65);   // changed since: left alone
  const svc = createBackupService({ ...inst, platform: 'linux', settings: memSettings(), hubInfo: () => ({}), modulePlaces: mod });
  mod.failList = true;
  const away = await svc.applyRetention({ keepNightly: 2, keepWeekly: 0, tz: NY, justMade: names[5] });
  assert.deepStrictEqual(mod.removed, [], 'nothing removed from a module that cannot list');
  assert.deepStrictEqual(away.failed, []);
  assert.strictEqual(fs.readdirSync(path.join(inst.hubHome, 'backups')).length, 2, 'the local copies were still tidied');
  mod.failList = false;
  const names2 = names;   // the local copies of the first four are gone: their records stay while the module holds them
  const r = await svc.applyRetention({ keepNightly: 2, keepWeekly: 0, tz: NY, justMade: names2[5] });
  assert.deepStrictEqual(r.failed, []);
  assert.deepStrictEqual(mod.removed.sort(), names.slice(1, 4).sort());
  assert.deepStrictEqual(mod.removedIds.sort(), names.slice(1, 4).map(n => `fid-${n}`).sort(), 'deleted by the recorded file id');
  assert.deepStrictEqual([...mod.store.keys()].sort(), [names[0], names[4], names[5]].sort());
  assert.ok(r.deleted.every(x => x.startsWith('Google Drive: ')));
  assert.deepStrictEqual(places.index(inst.root).map(b => b.name).sort(), [names[0], names[4], names[5]].sort());
  // a failed delete goes to failed
  mod.remove = async () => { throw new Error('no access'); };
  const names3 = nightly(inst, mod, 9).slice(6);
  const f = await svc.applyRetention({ keepNightly: 1, keepWeekly: 0, tz: NY, justMade: names3[2] });
  assert.ok(f.failed.length > 0 && f.failed.every(x => /no access/.test(x.error)));
});

test('a restore downloads a module-only backup into uploads (0700 folder, 0600 file) and checks its size', async () => {
  const inst = makeInstall(TMP, 'mod-restore');
  const mod = fakeModule();
  const names = nightly(inst, mod, 1);
  fs.rmSync(path.join(inst.hubHome, 'backups', names[0]));
  const svc = createBackupService({ ...inst, platform: 'linux', settings: memSettings(), hubInfo: () => ({}), modulePlaces: mod });
  const f = await svc.fileFor(names[0]);
  const up = path.join(restore.restoreDirs(inst.root).base, 'uploads');
  assert.strictEqual(path.dirname(f), up);
  assert.match(path.basename(f), /^[0-9a-f]{24}\.age$/);
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(up).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(f).size, 64);
  assert.throws(() => svc.filePath(names[0]), (e) => e.code === 'ENOFILE', 'the download route stays local-only');
  // the wrong size against the record: refused, nothing left behind
  mod.store.get(names[0]).bytes = Buffer.alloc(70);
  await assert.rejects(svc.fileFor(names[0]), /not the size/);
  assert.strictEqual(fs.readdirSync(up).length, 1);
  await assert.rejects(svc.fileFor('my-maestro-ai-2026-01-01-0000.age'), (e) => e.code === 'ENOFILE');
});

async function withBackup(name) {
  const inst = makeInstall(TMP, name);
  const mod = fakeModule();
  const svc = createBackupService({ ...inst, platform: 'linux', settings: memSettings(), hubInfo: () => ({}), modulePlaces: mod, wrongMax: 100 });
  await svc.setup('first long passphrase', { logN: 15 });
  const r = await svc.backupNow({ now: true });
  return { inst, mod, svc, r };
}

test('changePassword skips module copies and says so; a delete-mode rotation removes them by file id', async () => {
  const inst = makeInstall(TMP, 'mod-pw');
  const mod = fakeModule();
  const settings = memSettings();
  const svc = createBackupService({ ...inst, platform: 'linux', settings, hubInfo: () => ({}), modulePlaces: mod, wrongMax: 100 });
  await svc.setup('first long passphrase', { logN: 15 });
  assert.deepStrictEqual(svc.status().places.at(-1), { kind: 'module', id: 'drive', label: 'Google Drive' });
  const r = await svc.backupNow({ now: true });
  assert.strictEqual(r.backup.places[1].kind, 'module');
  assert.strictEqual(r.backup.places[1].fileId, 'fid-1');
  const before = Buffer.from(mod.store.get(r.backup.name).bytes);
  const c = await svc.changePassword({ password: 'first long passphrase', newPassword: 'second long passphrase', logN: 15 });
  assert.strictEqual(c.rewritten, 1, 'only the local copy');
  assert.deepStrictEqual(c.modules, [{ kind: 'module', id: 'drive', label: 'Google Drive', note: 'keeps the old password until newer nightly copies replace it' }]);
  assert.ok(mod.store.get(r.backup.name).bytes.equals(before), 'the module copy is untouched');
  assert.deepStrictEqual(c.unreachable, [], 'a module place that lists counts as reachable');
  const rot = await svc.startRotation({ password: 'second long passphrase', newPassword: 'third long passphrase', logN: 15 });
  assert.strictEqual(rot.waiting, 2);
  const f = await svc.finishRotation({ oldPassword: 'second long passphrase', newPassword: 'third long passphrase', action: 'delete' });
  assert.deepStrictEqual(f.failed, []);
  assert.strictEqual(f.deleted, 2, 'the local copy and the module copy');
  assert.deepStrictEqual(mod.removed, [r.backup.name]);
  assert.deepStrictEqual(mod.removedIds, ['fid-1']);
  assert.strictEqual(mod.store.size, 0);
  assert.strictEqual(f.retired.length, 1);
});

test('a re-encrypt rotation leaves module copies, keeps the old key retiring and says so', async () => {
  const { mod, svc, r } = await withBackup('mod-reenc');
  await svc.startRotation({ password: 'first long passphrase', newPassword: 'second long passphrase', logN: 15 });
  const before = Buffer.from(mod.store.get(r.backup.name).bytes);
  const f = await svc.finishRotation({ oldPassword: 'first long passphrase', newPassword: 'second long passphrase' });
  assert.strictEqual(f.reencrypted, 1, 'the local copy');
  assert.strictEqual(f.deleted, 0);
  assert.deepStrictEqual(mod.removed, [], 'no module copy deleted');
  assert.ok(mod.store.get(r.backup.name).bytes.equals(before));
  assert.deepStrictEqual(f.retired, [], 'the old key is kept while a module copy uses it');
  assert.deepStrictEqual(f.notes, ['Google Drive still holds 1 backup on the old key; they are replaced as newer nightlies arrive and the keep rules remove the old ones.']);
  assert.strictEqual(svc.status().retiring.length, 1);
});

test('a module that fails to list makes rotation and a password change wait', async () => {
  const { mod, svc } = await withBackup('mod-rot-wait');
  await svc.startRotation({ password: 'first long passphrase', newPassword: 'second long passphrase', logN: 15 });
  mod.failList = true;
  const f = await svc.finishRotation({ oldPassword: 'first long passphrase', newPassword: 'second long passphrase', action: 'delete' });
  assert.deepStrictEqual(f.unreachable, ['Google Drive']);
  assert.deepStrictEqual(f.retired, [], 'the key is not retired while the module cannot be checked');
  const c = await svc.changePassword({ password: 'second long passphrase', newPassword: 'third long passphrase', logN: 15 });
  assert.deepStrictEqual(c.unreachable, ['Google Drive']);
});

test('finishRotation (delete mode) records a module copy that cannot be deleted, and keeps the old key retiring', async () => {
  const { mod, svc } = await withBackup('mod-rot');
  await svc.startRotation({ password: 'first long passphrase', newPassword: 'second long passphrase', logN: 15 });
  mod.remove = async () => { throw new Error('Drive said no'); };
  const f = await svc.finishRotation({ oldPassword: 'first long passphrase', newPassword: 'second long passphrase', action: 'delete' });
  assert.deepStrictEqual(f.failed.map(x => [x.file.startsWith('Google Drive: '), x.error]), [[true, 'Drive said no']]);
  assert.deepStrictEqual(f.retired, []);
});

test('keep rules skip a module copy whose listed id is not the recorded one; a record with a module copy survives a night the module is switched off', async () => {
  const inst = makeInstall(TMP, 'mod-off');
  const mod = fakeModule();
  const names = nightly(inst, mod, 6);
  mod.store.get(names[1]).id = 'someone-elses';   // same name and size, another file
  const on = createBackupService({ ...inst, platform: 'linux', settings: memSettings(), hubInfo: () => ({}), modulePlaces: mod });
  await on.applyRetention({ keepNightly: 2, keepWeekly: 0, tz: NY, justMade: names[5] });
  assert.ok(mod.store.has(names[1]), 'not the recorded file: left alone');
  assert.ok(!mod.removedIds.includes('someone-elses'));
  // the module is switched off for the night: no module place is configured at all
  const off = createBackupService({ ...inst, platform: 'linux', settings: memSettings(), hubInfo: () => ({}), modulePlaces: { ...mod, places: () => [] } });
  const before = places.index(inst.root).map(b => b.name).sort();
  assert.ok(before.length >= 3, before.join());
  await off.applyRetention({ keepNightly: 2, keepWeekly: 0, tz: NY, justMade: names[5] });
  assert.deepStrictEqual(places.index(inst.root).map(b => b.name).sort(), before, 'every record with a module copy is kept');
  // a failing list does the same
  mod.failList = true;
  await on.applyRetention({ keepNightly: 2, keepWeekly: 0, tz: NY, justMade: names[5] });
  assert.deepStrictEqual(places.index(inst.root).map(b => b.name).sort(), before);
});

test('a restore download refuses when space is short, passes the file id, and checks the recorded md5', async () => {
  const inst = makeInstall(TMP, 'mod-restore2');
  const mod = fakeModule();
  const names = nightly(inst, mod, 1);
  fs.rmSync(path.join(inst.hubHome, 'backups', names[0]));
  const rec = places.index(inst.root)[0];
  const md5 = crypto.createHash('md5').update(Buffer.alloc(64, 1)).digest('hex');
  places.recordInIndex(inst.root, { ...rec, md5 });
  // short on space: the record says 64 bytes, and the check wants that plus 256 MiB
  const realStatfs = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: 1000, bsize: 1024 });
  try {
    const svc = createBackupService({ ...inst, platform: 'linux', settings: memSettings(), hubInfo: () => ({}), modulePlaces: mod });
    await assert.rejects(svc.fileFor(names[0]), (e) => e.code === 'ENOSPC' && /room/.test(e.message));
    assert.deepStrictEqual(mod.getCalls, [], 'nothing downloaded');
  } finally { fs.statfsSync = realStatfs; }
  const svc = createBackupService({ ...inst, platform: 'linux', settings: memSettings(), hubInfo: () => ({}), modulePlaces: mod });
  const f = await svc.fileFor(names[0]);
  assert.deepStrictEqual(mod.getCalls, [{ name: names[0], fileId: `fid-${names[0]}` }]);
  assert.strictEqual(fs.statSync(f).size, 64);
  mod.badMd5 = true;
  await assert.rejects(svc.fileFor(names[0]), /does not match/);
  const up = path.join(restore.restoreDirs(inst.root).base, 'uploads');
  assert.strictEqual(fs.readdirSync(up).length, 1, 'the refused download is removed');
});

test('a backup records the local and folder places before a module upload, and again after it; md5 only when a module is a target', async () => {
  const inst = makeInstall(TMP, 'mod-order');
  const settings = memSettings();
  await keys.setup('a strong test passphrase', { settings, logN: 15 });
  const mod = fakeModule();
  const put = mod.put;
  let seen = null;
  mod.put = async (...a) => { seen = places.index(inst.root).map(b => ({ places: b.places.map(p => p.kind), md5: b.md5 })); throw new Error('crash-like failure'); };
  const folder = places.folderPlace(path.join(TMP, 'mod-order-folder'));
  const r = await createBackup({ ...inst, platform: 'linux', _holdBoxes: () => () => {}, settings, hub: {}, places: [places.localPlace(inst.hubHome), { kind: 'module', id: 'drive', label: 'Google Drive' }, folder], modulePlaces: mod });
  assert.deepStrictEqual(seen.map(x => x.places), [['local', 'folder']], 'recorded before the upload, with local and folder');
  assert.match(seen[0].md5, /^[0-9a-f]{32}$/);
  assert.deepStrictEqual(places.index(inst.root)[0].places.map(p => p.kind), ['local', 'module', 'folder']);
  assert.ok(r.places.find(p => p.kind === 'module').error);
  const plain = await backupWith('mod-nomd5', null, { places: [] });
  assert.ok(!('md5' in places.index(plain.inst.root)[0]), 'no md5 without a module target');
  mod.put = put;
});

test('a module copy keeps its own key id through a re-encrypt rotation: a second finish does not retire the old key while Drive holds the copy', async () => {
  const { inst, mod, svc, r } = await withBackup('mod-own-key');
  const k1 = places.index(inst.root)[0].keyId;
  assert.strictEqual(places.index(inst.root)[0].places[1].keyId, k1, 'the module entry records the key it was made with');
  const rot = await svc.startRotation({ password: 'first long passphrase', newPassword: 'second long passphrase', logN: 15 });
  assert.strictEqual(rot.waiting, 2, 'local and Drive, both on K1');
  const f1 = await svc.finishRotation({ oldPassword: 'first long passphrase', newPassword: 'second long passphrase' });
  assert.strictEqual(f1.reencrypted, 1);
  assert.deepStrictEqual(f1.retired, []);
  const rec = places.index(inst.root)[0];
  assert.notStrictEqual(rec.keyId, k1, 'the record moved to the new key');
  assert.strictEqual(rec.places[1].keyId, k1, 'the Drive entry stayed on K1');
  const listed = (await svc.list())[0];
  assert.deepStrictEqual(listed.places.map(p => [p.kind, p.keyId]), [['local', rec.keyId], ['module', k1]]);
  assert.strictEqual(svc.status().retiring.length, 1);
  const f2 = await svc.finishRotation({ oldPassword: 'first long passphrase', newPassword: 'second long passphrase' });
  assert.deepStrictEqual(f2.retired, [], 'a second finish must not retire K1 while Drive holds a K1 copy');
  assert.strictEqual(f2.notes.length, 1);
  assert.strictEqual(svc.status().retiring.length, 1);
  assert.strictEqual(mod.store.size, 1);
  // the copy goes (keep rules): then K1 retires
  mod.store.delete(r.backup.name);
  const f3 = await svc.finishRotation({ oldPassword: 'first long passphrase', newPassword: 'second long passphrase' });
  assert.deepStrictEqual(f3.retired, [k1]);
  assert.strictEqual(svc.status().retiring.length, 0);
});

test('after the re-encrypt pass, a delete-mode finish removes the Drive copy by id and then retires the old key', async () => {
  const { mod, svc } = await withBackup('mod-own-key-del');
  await svc.startRotation({ password: 'first long passphrase', newPassword: 'second long passphrase', logN: 15 });
  await svc.finishRotation({ oldPassword: 'first long passphrase', newPassword: 'second long passphrase' });
  const f = await svc.finishRotation({ newPassword: 'second long passphrase', action: 'delete' });
  assert.strictEqual(f.deleted, 1);
  assert.strictEqual(mod.store.size, 0);
  assert.strictEqual(f.retired.length, 1);
});

test('a module copy of an old record (no key on it) uses the record key only if never re-encrypted; otherwise its key is unknown and blocks retiring', async () => {
  const { inst, svc } = await withBackup('mod-legacy');
  const rec = places.index(inst.root)[0];
  const strip = (extra) => places.recordInIndex(inst.root, { ...rec, ...extra, places: rec.places.map(q => { const { keyId, ...rest } = q; return q.kind === 'module' ? rest : q; }) });
  strip({});
  assert.strictEqual((await svc.list())[0].places[1].keyId, rec.keyId, 'never reindexed: the record key');
  strip({ reindexed: true });
  const p = (await svc.list())[0].places[1];
  assert.strictEqual(p.keyId, null);
  assert.strictEqual(p.keyUnknown, true);
  await svc.startRotation({ password: 'first long passphrase', newPassword: 'second long passphrase', logN: 15 });
  const f = await svc.finishRotation({ oldPassword: 'first long passphrase', newPassword: 'second long passphrase', action: 'delete' });
  assert.deepStrictEqual(f.retired, [], 'an unknown key on a copy blocks retirement');
  assert.ok(f.notes.some(n => /unknown key/.test(n)), JSON.stringify(f.notes));
});

test('rotation does not retire while a module failed to list in the same pass, or a record has a copy in a module that is switched off', async () => {
  const a = await withBackup('mod-inv-fail');
  await a.svc.startRotation({ password: 'first long passphrase', newPassword: 'second long passphrase', logN: 15 });
  a.mod.failList = true;
  const f = await a.svc.finishRotation({ oldPassword: 'first long passphrase', newPassword: 'second long passphrase', action: 'delete' });
  assert.deepStrictEqual(f.retired, []);
  assert.ok(f.notes.some(n => /could not be listed/.test(n)), JSON.stringify(f.notes));
  const c = await a.svc.changePassword({ password: 'second long passphrase', newPassword: 'third long passphrase', logN: 15 });
  assert.ok(c.notes.some(n => /could not be listed/.test(n)));

  // places.list reports the failure and keeps its return shape
  const fails = [];
  const listed = await places.list(a.inst.root, [{ kind: 'module', id: 'drive', label: 'Google Drive' }], a.mod, (p, e) => fails.push([p.id, e.message]));
  assert.deepStrictEqual(listed, []);
  assert.deepStrictEqual(fails, [['drive', 'offline']]);

  // the module is switched off: the record still says a copy is there on the old key
  const inst = makeInstall(TMP, 'mod-inv-off');
  const mod = fakeModule();
  let on = true;
  const svc = createBackupService({ ...inst, platform: 'linux', settings: memSettings(), hubInfo: () => ({}), modulePlaces: { ...mod, places: () => (on ? mod.places() : []) }, wrongMax: 100 });
  await svc.setup('first long passphrase', { logN: 15 });
  await svc.backupNow({ now: true });
  await svc.startRotation({ password: 'first long passphrase', newPassword: 'second long passphrase', logN: 15 });
  on = false;
  const g = await svc.finishRotation({ oldPassword: 'first long passphrase', newPassword: 'second long passphrase', action: 'delete' });
  assert.deepStrictEqual(g.retired, []);
  assert.ok(g.notes.some(n => /switched off or removed/.test(n)), JSON.stringify(g.notes));
});
