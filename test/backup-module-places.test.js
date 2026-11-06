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
const { createModulePlaces } = require('../lib/backup/module-places');
const { makeInstall, memSettings } = require('./helpers/backup-fixture');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-module-places-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const NAME = 'my-maestro-ai-2026-10-01-0330.age';
const MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
const NY = 'America/New_York';
const text = (o) => JSON.stringify(o);
const mcp = (o, isError = false) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : text(o) }], isError });
const md5Of = (file) => crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');

// a module place over a fake callTool; `answers[tool]` is what it returns (or a function of the args)
function placesWith(answers, extra = {}) {
  const calls = [];
  const connectors = { callTool: async (id, tool, args, o) => { calls.push({ id, tool, args, o }); const a = answers[tool]; let r = typeof a === 'function' ? a(args) : a; if (r && typeof r === 'object' && !r.content && !(r instanceof Error)) r = JSON.stringify(r); if (r instanceof Error) throw r; return r; } };
  return { mp: createModulePlaces({ modules: { backupModules: () => [{ id: 'drive', label: 'Google Drive' }] }, connectors, ...extra }), calls };
}

// an in-memory module with the four operations, for the places tests
function fakeModule({ label = 'Google Drive', id = 'drive' } = {}) {
  const store = new Map();
  const m = {
    store, failList: false, failPut: false, lie: null, putCalls: [], removed: [],
    places: () => [{ kind: 'module', id, label }],
    async put(i, file, name) { m.putCalls.push({ i, file, name }); if (m.failPut) throw new Error('Drive is full'); const b = fs.readFileSync(file); store.set(name, { bytes: b, created: new Date().toISOString() }); return { name, size: m.lie != null ? m.lie : b.length, md5: crypto.createHash('md5').update(b).digest('hex') }; },
    async list() { if (m.failList) throw new Error('offline'); return [...store].map(([name, v]) => ({ name, size: v.bytes.length, created: v.created })); },
    async remove(i, name) { m.removed.push(name); return store.delete(name); },
    async get(i, name, out) { const v = store.get(name); fs.writeFileSync(out, v.bytes); return { size: v.bytes.length, md5: crypto.createHash('md5').update(v.bytes).digest('hex') }; },
  };
  const wrap = (f) => (i, ...a) => f(i, ...a);
  m.list = wrap(m.list);
  return m;
}

test('module places: places() lists the finished, switched-on backup modules, and never throws', () => {
  const { mp } = placesWith({});
  assert.deepStrictEqual(mp.places(), [{ kind: 'module', id: 'drive', label: 'Google Drive' }]);
  assert.deepStrictEqual(createModulePlaces({ modules: { backupModules: () => { throw new Error('boom'); } }, connectors: {} }).places(), []);
});

test('module places: put/list/remove/get accept a string or an MCP result, call with the time limit, and check every shape', async () => {
  const { mp, calls } = placesWith({
    backup_put: (a) => ({ name: a.name, size: 10, md5: MD5 }),
    backup_list: mcp({ files: [{ name: NAME, size: 5, created: '2026-10-01T07:30:00Z' }, { name: 'notes.txt', size: 1 }, { name: NAME.replace('10-01', '10-02'), size: -1 }] }),
    backup_delete: text({ deleted: true }),
    backup_get: mcp({ size: 7, md5: MD5.toUpperCase() }),
  }, { timeoutMs: 1234 });
  assert.deepStrictEqual(await mp.put('drive', '/x/f.age', NAME), { name: NAME, size: 10, md5: MD5 });
  assert.deepStrictEqual(calls[0], { id: 'drive', tool: 'backup_put', args: { file: '/x/f.age', name: NAME }, o: { timeoutMs: 1234 } });
  assert.deepStrictEqual(await mp.list('drive'), [{ name: NAME, size: 5, created: '2026-10-01T07:30:00Z' }], 'only well-formed names and sizes');
  assert.strictEqual(await mp.remove('drive', NAME), true);
  assert.deepStrictEqual(await mp.get('drive', NAME, '/x/out.age'), { size: 7, md5: MD5 });
  assert.deepStrictEqual(calls[3].args, { name: NAME, out: '/x/out.age' });
});

test('module places: a failure, an error result, bad JSON and bad shapes are plain errors', async () => {
  const bad = async (answers, fn, re) => { const { mp } = placesWith(answers); await assert.rejects(fn(mp), re); };
  await bad({ backup_put: new Error('timed out') }, (m) => m.put('drive', '/f', NAME), /backup_put failed: timed out/);
  await bad({ backup_put: mcp('Drive is full', true) }, (m) => m.put('drive', '/f', NAME), /Drive is full/);
  await bad({ backup_put: 'not json' }, (m) => m.put('drive', '/f', NAME), /did not answer with JSON/);
  await bad({ backup_put: '[1]' }, (m) => m.put('drive', '/f', NAME), /wrong shape/);
  await bad({ backup_put: undefined }, (m) => m.put('drive', '/f', NAME), /no answer/);
  await bad({ backup_put: { name: NAME, size: -1, md5: MD5 } }, (m) => m.put('drive', '/f', NAME), /how big/);
  await bad({ backup_put: { name: NAME, size: 1.5, md5: MD5 } }, (m) => m.put('drive', '/f', NAME), /how big/);
  await bad({ backup_put: { name: NAME, size: 1, md5: 'xyz' } }, (m) => m.put('drive', '/f', NAME), /checksum/);
  await bad({ backup_put: { name: 'other.age', size: 1, md5: MD5 } }, (m) => m.put('drive', '/f', NAME), /another name/);
  await bad({}, (m) => m.put('drive', '/f', '../evil.age'), /not a backup name/);
  await bad({ backup_list: { files: 'x' } }, (m) => m.list('drive'), /wrong shape/);
  await bad({ backup_delete: { deleted: 'yes' } }, (m) => m.remove('drive', NAME), /wrong shape/);
  await bad({ backup_get: { size: 3 } }, (m) => m.get('drive', NAME, '/o'), /checksum/);
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
  assert.deepStrictEqual(a.r.places[1], { kind: 'module', id: 'drive', label: 'Google Drive', name: a.r.name, size: a.r.size });
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
  assert.deepStrictEqual(w, { kind: 'module', id: 'drive', label: 'Google Drive', size: a.r.size, readable: true, keyId: places.index(a.inst.root)[0].keyId });
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
    mod.store.set(name, { bytes: Buffer.alloc(64, 1), created: d.toISOString() });
    places.recordInIndex(inst.root, { id: name.replace(/\.age$/, ''), name, created: d.toISOString(), size: 64, reason: 'nightly', places: [{ kind: 'local', dir: local, file: path.join(local, name) }, { kind: 'module', id: 'drive', label: 'Google Drive', name, size: 64 }] });
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

test('changePassword skips module copies and says so; finishRotation deletes the ones made with the old key', async () => {
  const inst = makeInstall(TMP, 'mod-pw');
  const mod = fakeModule();
  const settings = memSettings();
  const svc = createBackupService({ ...inst, platform: 'linux', settings, hubInfo: () => ({}), modulePlaces: mod, wrongMax: 100 });
  await svc.setup('first long passphrase', { logN: 15 });
  assert.deepStrictEqual(svc.status().places.at(-1), { kind: 'module', id: 'drive', label: 'Google Drive' });
  const r = await svc.backupNow({ now: true });
  assert.strictEqual(r.backup.places[1].kind, 'module');
  const before = Buffer.from(mod.store.get(r.backup.name).bytes);
  const c = await svc.changePassword({ password: 'first long passphrase', newPassword: 'second long passphrase', logN: 15 });
  assert.strictEqual(c.rewritten, 1, 'only the local copy');
  assert.deepStrictEqual(c.modules, [{ kind: 'module', id: 'drive', label: 'Google Drive', note: 'keeps the old password until newer nightly copies replace it' }]);
  assert.ok(mod.store.get(r.backup.name).bytes.equals(before), 'the module copy is untouched');
  assert.deepStrictEqual(c.unreachable, [], 'a module place counts as reachable');
  const rot = await svc.startRotation({ password: 'second long passphrase', newPassword: 'third long passphrase', logN: 15 });
  assert.strictEqual(rot.waiting, 2);
  const f = await svc.finishRotation({ oldPassword: 'second long passphrase', newPassword: 'third long passphrase' });
  assert.deepStrictEqual(f.failed, []);
  assert.strictEqual(f.reencrypted, 1);
  assert.strictEqual(f.deleted, 1);
  assert.deepStrictEqual(mod.removed, [r.backup.name]);
  assert.strictEqual(mod.store.size, 0);
  assert.strictEqual(f.retired.length, 1);
});

test('finishRotation records a module copy that cannot be deleted, and keeps the old key retiring', async () => {
  const inst = makeInstall(TMP, 'mod-rot');
  const mod = fakeModule();
  const svc = createBackupService({ ...inst, platform: 'linux', settings: memSettings(), hubInfo: () => ({}), modulePlaces: mod, wrongMax: 100 });
  await svc.setup('first long passphrase', { logN: 15 });
  await svc.backupNow({ now: true });
  await svc.startRotation({ password: 'first long passphrase', newPassword: 'second long passphrase', logN: 15 });
  mod.remove = async () => { throw new Error('Drive said no'); };
  const f = await svc.finishRotation({ oldPassword: 'first long passphrase', newPassword: 'second long passphrase' });
  assert.deepStrictEqual(f.failed.map(x => [x.file.startsWith('Google Drive: '), x.error]), [[true, 'Drive said no']]);
  assert.deepStrictEqual(f.retired, []);
});
