'use strict';
// Call recordings across a restore or an undo, fix round 1 (lib/backup/apply.js, restore.js, recordings-merge.js):
// a restore never changes who may download, a collision keeps the fuller copy, and a backup with no key never strands the files.
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
const { mergeRecordings } = require('../lib/backup/recordings-merge');
const { deriveKey } = require('../lib/recordings/crypt');
const { createStore } = require('../lib/recordings/store');
const { RECORDINGS } = require('../lib/hub-home');
const { makeInstall, memSettings } = require('./helpers/backup-fixture');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-recordings-fix1-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const PW = 'recordings fix test passphrase';

function wav(n = 160, rate = 8000) {
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'latin1'); b.write('fmt ', 12, 'latin1');
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36, 'latin1'); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE((i * 37) % 2000 - 1000, 44 + i * 2);
  return b;
}
const keyPath = (inst) => path.join(inst.root, 'data', '.auth-key');
const keyHex = (inst) => fs.readFileSync(keyPath(inst), 'utf8').trim();
const storeAt = (root, hex) => createStore({ root, key: deriveKey(Buffer.from(hex, 'hex')) });
const liveStore = (inst, hex = keyHex(inst)) => storeAt(path.join(inst.hubHome, RECORDINGS), hex);
async function record(inst, agent = 'biographer') {
  const s = liveStore(inst);
  const { sessionId } = await s.createSession(agent, { userId: 'owner' });
  await s.addSegment(agent, sessionId, { speaker: 'person', wav: wav(), startedAt: new Date().toISOString() });
  await s.finish(agent, sessionId);
  return sessionId;
}
const agentsFile = (inst) => path.join(inst.root, 'data', 'agents.json');
const readAgents = (inst) => JSON.parse(fs.readFileSync(agentsFile(inst), 'utf8'));
const writeAgents = (inst, list) => fs.writeFileSync(agentsFile(inst), JSON.stringify(list, null, 2));
const REC = (o = {}) => ({ keep: true, allowed: ['u1'], keepReplies: false, consentLine: 'This conversation is being recorded for the family.', mic: 'processed', ...o });

async function backupOf(name, agents, { beforeBackup } = {}) {
  const inst = makeInstall(TMP, name);
  const settings = memSettings();
  await keys.setup(PW, { settings, logN: 15 });
  if (agents) writeAgents(inst, agents);
  const sid = await record(inst);
  if (beforeBackup) beforeBackup(inst);
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

// ── 2. a restore or an undo never changes who may download ──
test('restore: agents in both lists keep today\'s recordings setting (or none); an agent only in the backup keeps the backup\'s, its allowed cut to existing, enabled accounts', async () => {
  const { inst, file } = await backupOf('settings-keep', [
    { name: 'biographer', recordings: REC({ allowed: ['u1', 'u0'], keepReplies: true, mic: 'unprocessed', consentLine: 'From the backup.' }) },
    { name: 'helper', recordings: REC({ allowed: ['u1'] }) },
    { name: 'life-story', recordings: REC({ allowed: ['u1', 'u0', 'u-gone'] }) },
    { name: 'plain' },
  ]);
  // today: different lists. biographer has other settings, helper has none, plain gained some, life-story is gone, and u0 no longer exists
  writeAgents(inst, [
    { name: 'biographer', recordings: REC({ keep: false, allowed: ['u1'], keepReplies: false, mic: 'processed', consentLine: 'Today\'s line.' }) },
    { name: 'helper' },
    { name: 'plain', recordings: REC({ allowed: ['u1'] }) },
  ]);
  const users = JSON.parse(fs.readFileSync(path.join(inst.root, 'data', 'users.json'), 'utf8'));
  users.users = users.users.filter(u => u.id !== 'u0');
  fs.writeFileSync(path.join(inst.root, 'data', 'users.json'), JSON.stringify(users));
  const todaysBiographer = readAgents(inst).find(a => a.name === 'biographer').recordings;

  const { applied } = await restoreAndApply(inst, file);
  const after = Object.fromEntries(readAgents(inst).map(a => [a.name, a]));
  assert.deepStrictEqual(after.biographer.recordings, todaysBiographer, 'keep, allowed, keepReplies, consentLine and mic are today\'s');
  assert.ok(!('recordings' in after.helper), 'today has none: none');
  assert.deepStrictEqual(after.plain.recordings, REC({ allowed: ['u1'] }), 'today\'s setting on an agent the backup had without one');
  assert.deepStrictEqual(after['life-story'].recordings.allowed, ['u1'], 'u0 came back disabled and u-gone does not exist: only u1 stays');
  assert.strictEqual(after['life-story'].recordings.keep, true, 'the rest of the backup\'s setting stays');
  assert.strictEqual(applied.journal.report.recordings.settingsKept, 3, 'biographer, helper and plain had a setting on one side');
});

test('undo: the agents keep the recordings setting they had just before the undo', async () => {
  const { inst, file } = await backupOf('settings-undo', [{ name: 'biographer', recordings: REC({ allowed: ['u1'] }) }]);
  await restoreAndApply(inst, file);
  assert.ok(apply.markHealthy({ root: inst.root }));
  const later = REC({ keep: true, allowed: ['u1', 'u0'], keepReplies: true, mic: 'unprocessed', consentLine: 'Changed after the restore.' });
  writeAgents(inst, [{ name: 'biographer', recordings: later }, { name: 'newcomer', recordings: REC() }]);
  apply.confirmUndo({ root: inst.root });
  const r = apply.applyAtBoot({ root: inst.root });
  assert.strictEqual(r.kind, 'undo');
  const after = Object.fromEntries(readAgents(inst).map(a => [a.name, a]));
  assert.deepStrictEqual(after.biographer.recordings, later, 'the list that was in force at the undo');
  assert.strictEqual(r.journal.report.recordings.settingsKept, 1);
});

// ── 3. a collision keeps the fuller copy ──
function twin({ liveHex, stagedHex, live, staged }) {
  // the same session id on both sides (same clock, same random part), different numbers of segments
  const mk = (root, hex) => createStore({ root, key: deriveKey(Buffer.from(hex, 'hex')), now: () => Date.UTC(2026, 10, 13, 22, 0, 0), randomHex: (n) => 'ab'.repeat(n) });
  return { ls: mk(live, liveHex), ss: mk(staged, stagedHex) };
}
async function fill(store, n) {
  const { sessionId } = await store.createSession('life-story', { userId: 'owner' });
  for (let i = 0; i < n; i++) await store.addSegment('life-story', sessionId, { speaker: 'person', wav: wav(), startedAt: '2026-11-13T22:00:00.000Z' });
  return sessionId;
}
const HEX_A = 'a'.repeat(64), HEX_B = 'b'.repeat(64);
const buf = (h) => Buffer.from(h, 'hex');

test('collision: the live copy (its manifest opens with today\'s key) replaces the staged copy (re-sealed), and the staged copy is set aside outside the placed folder, never deleted', async () => {
  const live = path.join(TMP, 'col1-live'), staged = path.join(TMP, 'col1-staged'), displaced = path.join(TMP, 'col1-aside.displaced');
  const { ls, ss } = twin({ liveHex: HEX_A, stagedHex: HEX_B, live, staged });
  const sid = await fill(ls, 3);
  assert.strictEqual(await fill(ss, 1), sid, 'the same session id on both sides');
  const r = mergeRecordings({ live, staged, displaced, liveInstallKey: buf(HEX_A), stagedInstallKey: buf(HEX_B) });
  assert.strictEqual(r.replacedByLive, 1);
  assert.strictEqual(r.carried, 0, 'it was not a session only live had');
  assert.strictEqual(r.resealedSessions, 1);
  assert.deepStrictEqual(r.unopened, []);
  const placed = createStore({ root: staged, key: deriveKey(buf(HEX_B)) });
  assert.strictEqual((await placed.readManifest('life-story', sid)).entries.length, 3, 'the fuller copy, opened with the staged key');
  assert.ok((await placed.readSegment('life-story', sid, 3)).length > 4);
  const aside = path.join(displaced, 'life-story', sid);
  assert.ok(fs.existsSync(path.join(aside, 'manifest.json.enc')), 'the incoming copy is kept in the restore\'s set-aside area: <aside>.displaced/<agent>/<sid>');
  assert.ok(fs.existsSync(path.join(aside, '0001-person.flac.enc')));
  assert.deepStrictEqual(fs.readdirSync(path.join(staged, 'life-story')), [sid], 'nothing but the session inside the placed folder (no <sid>.older-<n>)');
  assert.deepStrictEqual((await placed.listSessions('life-story')).map(s => s.sessionId), [sid]);
  // a second run (after a stop) changes nothing and puts no second aside copy
  const again = mergeRecordings({ live, staged, displaced, liveInstallKey: buf(HEX_A), stagedInstallKey: buf(HEX_B) });
  assert.strictEqual(again.replacedByLive, 0);
  assert.deepStrictEqual(fs.readdirSync(path.join(staged, 'life-story')), [sid]);
  assert.deepStrictEqual(fs.readdirSync(path.join(displaced, 'life-story')), [sid]);
});

test('collision: an older snapshot never beats the session live today, even when it has more entries than the live copy', async () => {
  // sessions only grow, so the one live today is the newer, whatever the counts say
  const live = path.join(TMP, 'col2-live'), staged = path.join(TMP, 'col2-staged'), displaced = path.join(TMP, 'col2-aside.displaced');
  const { ls, ss } = twin({ liveHex: HEX_A, stagedHex: HEX_A, live, staged });
  const sid = await fill(ls, 1);
  await fill(ss, 3);
  const r = mergeRecordings({ live, staged, displaced, liveInstallKey: buf(HEX_A), stagedInstallKey: buf(HEX_A) });
  assert.strictEqual(r.replacedByLive, 1);
  assert.strictEqual((await createStore({ root: staged, key: deriveKey(buf(HEX_A)) }).readManifest('life-story', sid)).entries.length, 1, 'today\'s copy is placed');
  assert.strictEqual((await createStore({ root: displaced, key: deriveKey(buf(HEX_A)) }).readManifest('life-story', sid)).entries.length, 3, 'the incoming copy is kept aside');
  assert.deepStrictEqual(fs.readdirSync(path.join(staged, 'life-story')), [sid]);
});

test('collision: a copy already set aside is not overwritten by a second run', async () => {
  const live = path.join(TMP, 'col3-live'), staged = path.join(TMP, 'col3-staged'), displaced = path.join(TMP, 'col3-aside.displaced');
  const { ls, ss } = twin({ liveHex: HEX_A, stagedHex: HEX_A, live, staged });
  const sid = await fill(ls, 2);
  await fill(ss, 1);
  fs.mkdirSync(path.join(displaced, 'life-story', sid), { recursive: true });
  const r = mergeRecordings({ live, staged, displaced, liveInstallKey: buf(HEX_A), stagedInstallKey: buf(HEX_A) });
  assert.strictEqual(r.replacedByLive, 0);
  assert.deepStrictEqual(fs.readdirSync(path.join(displaced, 'life-story', sid)), []);
});

test('collision: when today\'s manifest can not be opened the incoming copy stays', async () => {
  const live = path.join(TMP, 'col4-live'), staged = path.join(TMP, 'col4-staged'), displaced = path.join(TMP, 'col4-aside.displaced');
  const { ls, ss } = twin({ liveHex: HEX_A, stagedHex: HEX_A, live, staged });
  const sid = await fill(ls, 3);
  await fill(ss, 1);
  const r = mergeRecordings({ live, staged, displaced, liveInstallKey: null, stagedInstallKey: buf(HEX_A) });   // today's key unreadable: manifests can't be opened
  assert.strictEqual(r.replacedByLive, 0);
  assert.strictEqual((await createStore({ root: staged, key: deriveKey(buf(HEX_A)) }).readManifest('life-story', sid)).entries.length, 1, 'the incoming copy is the one used');
  assert.ok(!fs.existsSync(displaced), 'nothing set aside');
});

test('restore end to end: a session recorded on after the backup replaces the backup\'s shorter copy; the report says so', async () => {
  const { inst, file, sid } = await backupOf('collide-e2e', [{ name: 'biographer' }]);
  // the same session grew after the backup: one more entry (an unfinished session takes more pieces)
  const s = liveStore(inst);
  const { sessionId } = await s.createSession('biographer', { userId: 'owner' });
  await s.addSegment('biographer', sessionId, { speaker: 'person', wav: wav(), startedAt: new Date().toISOString() });
  const { prepared } = { prepared: await restore.prepare({ file, password: PW, ...inst, platform: 'linux', mode: 'existing' }) };
  // plant the later session's folder in the staged recordings as if the backup had it with fewer entries
  const stagedRec = path.join(inst.root, '.restore', 'new', 'home', RECORDINGS, 'biographer');
  fs.cpSync(path.join(inst.hubHome, RECORDINGS, 'biographer', sessionId), path.join(stagedRec, sessionId), { recursive: true });
  await s.addSegment('biographer', sessionId, { speaker: 'person', wav: wav(), startedAt: new Date().toISOString() });
  apply.confirm({ ...inst, platform: 'linux', id: prepared.id });
  const r = apply.applyAtBoot({ root: inst.root });
  assert.strictEqual(r.state, 'applied');
  assert.strictEqual(r.journal.report.recordings.replacedByLive, 2, 'the session that grew, and the one in both copies unchanged: today\'s copy wins on every collision');
  const m = await liveStore(inst).readManifest('biographer', sessionId);
  assert.strictEqual(m.entries.length, 2, 'the fuller copy is the one in place');
  assert.deepStrictEqual(fs.readdirSync(path.join(inst.hubHome, RECORDINGS, 'biographer')).sort(), [sessionId, sid].sort(), 'nothing extra inside the placed folder');
  const mv = r.journal.moves.find(x => x.live === path.join(inst.hubHome, RECORDINGS));
  assert.ok(fs.existsSync(path.join(`${mv.aside}.displaced`, 'biographer', sessionId, 'manifest.json.enc')), 'the backup\'s older copy is in the set-aside area, beside the live set-aside folder');
  assert.ok(sid);
});

// ── 4. no key, no stranding ──
test('a backup with no .auth-key: today\'s key (mode 0600) goes into the placed data folder and today\'s recordings are copied unchanged', async () => {
  const { inst, file, sid } = await backupOf('nokey', [{ name: 'biographer' }], { beforeBackup: (i) => fs.unlinkSync(keyPath(i)) });
  fs.writeFileSync(keyPath(inst), 'c'.repeat(64), { mode: 0o600 });   // today's key (the backup was made without one)
  const todays = keyHex(inst);
  const mine = await record(inst);   // sealed with today's key
  const { applied } = await restoreAndApply(inst, file);
  assert.strictEqual(keyHex(inst), todays, 'today\'s key stands in for the backup\'s missing one');
  assert.strictEqual(fs.statSync(keyPath(inst)).mode & 0o777, 0o600);
  const rep = applied.journal.report.recordings;
  assert.strictEqual(rep.carried, 1);
  assert.strictEqual(rep.resealed, 0, 'equal keys: copied unchanged');
  assert.deepStrictEqual(rep.notOpened, []);
  const s = liveStore(inst);
  assert.strictEqual((await s.readManifest('biographer', mine)).sessionId, mine, 'opens with the key now in place');
  assert.ok(sid);
});

test('neither the backup nor today has a key while recordings exist: the restore is refused when it is prepared, with a plain error, and nothing changes', async () => {
  const { inst, file } = await backupOf('nokey-either', [{ name: 'biographer' }], { beforeBackup: (i) => fs.unlinkSync(keyPath(i)) });
  fs.writeFileSync(keyPath(inst), 'd'.repeat(64), { mode: 0o600 });
  await record(inst);
  fs.unlinkSync(keyPath(inst));
  await assert.rejects(restore.prepare({ file, password: PW, ...inst, platform: 'linux', mode: 'existing' }), (e) => /call recordings/.test(e.message) && /\.auth-key/.test(e.message) && e.code === 'ENOKEY');
  assert.ok(!fs.existsSync(path.join(inst.root, '.restore', 'journal.json')), 'no journal');
  assert.ok(!fs.existsSync(path.join(inst.root, '.restore', 'new')), 'nothing staged');
  assert.ok(fs.readdirSync(path.join(inst.hubHome, RECORDINGS, 'biographer')).length >= 1, 'the recordings are untouched');
});
