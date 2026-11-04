'use strict';
// Making a backup (lib/backup/collect.js, create.js, places.js, keys.js) from a throwaway install in the older layout
// (home folders beside the program folder): what goes in, what stays out, links, databases with unsaved WAL pages,
// the AI sign-ins and current conversations, files that change while copied, places, the index and the list.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable, Writable } = require('stream');
const Database = require('better-sqlite3');
const fmt = require('../lib/backup/format');
const keys = require('../lib/backup/keys');
const places = require('../lib/backup/places');
const { createBackup } = require('../lib/backup/create');
const { readTar } = require('../lib/backup/tar');
const { encodeClaudeProject } = require('../lib/backup/collect');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-create-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const hasAge = spawnSync('age', ['--version']).status === 0;
const SID = '11111111-2222-4333-8444-555555555555', TID = '01a0d0a5-93ff-7b00-ad3f-63e4291d147f';
const w = (f, s, mode) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s, mode ? { mode } : undefined); };

function makeInstall(name) {
  const hubHome = path.join(TMP, name), root = path.join(hubHome, 'app'), home = path.join(TMP, `${name}-home`);
  const d = (...p) => path.join(root, 'data', ...p);
  w(d('settings.json'), JSON.stringify({ providers: { anthropic: { apiKey: 'sk-test-123' } } }), 0o600);
  w(d('agents.json'), JSON.stringify([{ name: 'doc' }, { name: 'a' }, { name: 'open' }]));
  w(d('users.json'), JSON.stringify([{ id: 'u1', login: 'owner@example.com' }]));
  w(d('agent-sessions.json'), JSON.stringify({ doc: { sessionId: SID } }));
  w(d('codex-sessions.json'), JSON.stringify({ open: { threadId: TID } }));
  w(d('conversations', 'doc.jsonl'), '{"role":"user","content":"hi"}\n');
  w(d('.auth-key'), 'k'.repeat(64), 0o600);
  w(d('setup-token'), 'one-time');
  w(d('hardware-state.json'), '{}');
  w(d('local-models', 'bin', 'llama-server'), 'binary');
  w(d('local-models', 'config.yaml'), 'models: {}');
  w(d('._agents.json'), 'mac junk');
  w(d('uploads', 'img.png'), Buffer.alloc(5000, 7));
  w(d('jobs', 'j1', 'out.log'), 'long log');
  w(d('jobs', 'j1', 'job.json'), '{}');
  const db = new Database(d('test.db'));
  db.pragma('journal_mode = WAL'); db.pragma('wal_autocheckpoint = 0');
  db.exec('create table t (x)');
  const ins = db.prepare('insert into t values (?)');
  for (let i = 0; i < 500; i++) ins.run(i);   // left in the WAL: no checkpoint
  w(path.join(root, 'workspaces', 'doc', 'SOUL.md'), 'I am Doc');
  w(path.join(hubHome, 'medical', 'patients', 'patient-a.md'), 'notes');
  fs.mkdirSync(path.join(root, 'workspaces', 'doc', 'records'), { recursive: true });
  fs.symlinkSync(path.join(hubHome, 'medical', 'patients', 'patient-a.md'), path.join(root, 'workspaces', 'doc', 'records', 'patient-a.md'));
  fs.symlinkSync('/etc/hostname', path.join(root, 'workspaces', 'doc', 'outside'));
  w(path.join(root, 'workspaces', 'a', 'busy.log'), 'start');
  w(path.join(hubHome, 'share', 'common', 'f.txt'), 'shared');
  w(path.join(hubHome, 'users', 'u_1', 'files', 'x.txt'), 'member file');
  w(path.join(root, '.env'), 'PORT=9966\n', 0o600);
  w(path.join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{}}', 0o600);
  w(path.join(home, '.claude', 'projects', encodeClaudeProject(root), `${SID}.jsonl`), '{"session":1}\n');
  w(path.join(home, '.claude', 'projects', encodeClaudeProject(root), 'other-session.jsonl'), 'not current');
  w(path.join(home, '.codex', 'auth.json'), '{"tokens":{}}', 0o600);
  w(path.join(home, '.codex', 'config.toml'), 'model = "x"');
  w(path.join(home, '.codex', 'sessions', '2026', '10', '01', `rollout-2026-10-01T00-00-00-${TID}.jsonl`), '{"thread":1}\n');
  return { hubHome, root, home, db };
}
function memSettings() { const obj = {}; return { obj, get: () => obj, update: (p) => Object.assign(obj, p) }; }
async function openBackup(file, how) {
  const files = new Map(); const meta = new Map();
  const tarBytes = [];
  await pipeline(fs.createReadStream(file), fmt.createDecryptStream({ unlock: fmt.unlockWith(how) }), zlib.createGunzip(), new Writable({ write(c, _e, cb) { tarBytes.push(c); cb(); } }));
  for await (const e of readTar([Buffer.concat(tarBytes)])) {
    meta.set(e.path, e);
    if (e.type === 'file') { const c = []; for await (const x of e.content()) c.push(x); files.set(e.path, Buffer.concat(c)); }
  }
  return { files, meta, manifest: JSON.parse(files.get('manifest.json')), order: [...meta.keys()] };
}

test('a backup holds everything the design lists, and leaves out what a new computer makes or downloads', async () => {
  const inst = makeInstall('one');
  const settings = memSettings();
  const { recoveryKey } = await keys.setup('a strong test passphrase', { settings, logN: 15 });
  const folder = path.join(TMP, 'one-folder');
  const r = await createBackup({ ...inst, platform: 'linux', settings, places: [places.localPlace(inst.hubHome), places.folderPlace(folder)], hub: { version: '5.8.1', channel: 'experimental' } });
  assert.match(r.name, /^my-maestro-ai-\d{4}-\d{2}-\d{2}-\d{4}\.age$/);
  for (const p of r.places) { assert.ok(fs.existsSync(p.file), p.file); assert.strictEqual(fs.statSync(p.file).mode & 0o777, 0o600); }
  assert.deepStrictEqual(fs.readdirSync(path.join(inst.hubHome, 'backups')).filter(n => n.startsWith('.')), [], 'no snapshot or partial file left');
  const b = await openBackup(r.places[0].file, { password: 'a strong test passphrase' });
  assert.strictEqual(b.order[0], 'manifest.json', 'the manifest comes first');
  const has = (p) => b.meta.has(p);
  for (const p of ['data/settings.json', 'data/agents.json', 'data/.auth-key', 'data/conversations/doc.jsonl', 'data/local-models/config.yaml', 'data/uploads/img.png', 'data/jobs/j1/job.json', 'data/test.db',
    'workspaces/doc/SOUL.md', 'home/medical/patients/patient-a.md', 'home/share/common/f.txt', 'home/users/u_1/files/x.txt', 'env/.env',
    'external/claude/.credentials.json', `external/claude/projects/${SID}.jsonl`, 'external/codex/auth.json', 'external/codex/config.toml',
    `external/codex/sessions/2026/10/01/rollout-2026-10-01T00-00-00-${TID}.jsonl`]) assert.ok(has(p), `in: ${p}`);
  for (const p of ['data/setup-token', 'data/hardware-state.json', 'data/local-models/bin/llama-server', 'data/._agents.json', 'data/jobs/j1/out.log', 'data/test.db-wal', 'data/test.db-shm',
    'external/claude/projects/other-session.jsonl', 'workspaces/doc/outside']) assert.ok(!has(p), `out: ${p}`);
  // the database holds the rows that were only in its WAL
  const dbFile = path.join(TMP, 'restored.db'); fs.writeFileSync(dbFile, b.files.get('data/test.db'));
  assert.strictEqual(new Database(dbFile, { readonly: true }).prepare('select count(*) n from t').get().n, 500);
  // links: kept inside the backup (as an archive path), listed when they point outside
  const link = b.manifest.entries.find(e => e.path === 'workspaces/doc/records/patient-a.md');
  assert.deepStrictEqual([link.type, link.target], ['link', 'home/medical/patients/patient-a.md']);
  assert.deepStrictEqual(b.manifest.linksOutside, [{ path: 'workspaces/doc/outside', target: '/etc/hostname' }]);
  // checksums and the manifest's facts
  const crypto = require('crypto');
  for (const e of b.manifest.entries.filter(x => x.type === 'file')) assert.strictEqual(crypto.createHash('sha256').update(b.files.get(e.path)).digest('hex'), e.sha256, e.path);
  assert.strictEqual(b.manifest.counts.agents, 3);
  assert.strictEqual(b.manifest.origin.layout, 'beside');
  assert.strictEqual(b.manifest.label, 'taken while agents were idle');
  assert.strictEqual(b.files.get('data/settings.json').toString(), JSON.stringify({ providers: { anthropic: { apiKey: 'sk-test-123' } } }));
  // the index and the list
  assert.strictEqual(places.index(inst.root)[0].name, r.name);
  const listed = await places.list(inst.root, [places.localPlace(inst.hubHome), places.folderPlace(folder)]);
  assert.strictEqual(listed.length, 1);
  assert.deepStrictEqual([listed[0].version, listed[0].places.length, listed[0].made], ['5.8.1', 2, true]);
  // the recovery key opens it as well, with the stock age tool and tar
  if (hasAge) {
    const idf = path.join(TMP, 'id.txt'); fs.writeFileSync(idf, recoveryKey + '\n', { mode: 0o600 });
    const plain = spawnSync('age', ['-d', '-i', idf, r.places[1].file], { maxBuffer: 1 << 27 });
    assert.strictEqual(plain.status, 0, String(plain.stderr));
    const t = spawnSync('tar', ['-tzf', '-'], { input: plain.stdout, encoding: 'utf8', maxBuffer: 1 << 27 });
    assert.strictEqual(t.stdout.split('\n')[0], 'manifest.json');
  }
});

test('on a Mac the Claude sign-in (kept in the Keychain) is not looked for; files that keep changing are named', async () => {
  const inst = makeInstall('two');
  const settings = memSettings();
  await keys.setup('another strong passphrase', { settings, logN: 15 });
  let n = 0;
  const r = await createBackup({ ...inst, platform: 'darwin', _holdBoxes: () => () => {}, settings, working: ['doc'], hub: { version: '5.8.1' },   // never real containers in a test
    _snapshot: { _afterCopy: async (arch, abs) => { if (arch === 'workspaces/a/busy.log') fs.appendFileSync(abs, `+${++n}`); } } });
  const b = await openBackup(r.places[0].file, { password: 'another strong passphrase' });
  assert.ok(!b.meta.has('external/claude/.credentials.json'));
  assert.ok(b.meta.has('external/codex/auth.json'));
  assert.deepStrictEqual(b.manifest.unsettled, ['workspaces/a/busy.log']);
  assert.strictEqual(n, 4, 'copied once and retried three times');
  assert.strictEqual(b.manifest.label, 'taken while agents worked');
  assert.deepStrictEqual(b.manifest.working, ['doc']);
  assert.ok(b.manifest.notCovered.some(x => /Keychain/.test(x)));
});

test('no backup without a key; weak passwords are refused with plain words', async () => {
  const inst = makeInstall('three');
  await assert.rejects(createBackup({ ...inst, settings: memSettings() }), (e) => e.code === 'ENOKEY');
  for (const bad of ['short', 'aaaaaaaaaaaaaaa', '123456789012345', 'Password12345', 'qwertyqwertyqwerty']) assert.throws(() => keys.checkPassword(bad), (e) => e.code === 'EWEAK', bad);
  assert.doesNotThrow(() => keys.checkPassword('lantern orbit mellow cactus'));
  const s = memSettings();
  assert.deepStrictEqual(keys.status({ settings: s }), { configured: false });
  const { keyId } = await keys.setup('lantern orbit mellow cactus', { settings: s, logN: 15 });
  assert.deepStrictEqual([keys.status({ settings: s }).configured, keys.status({ settings: s }).keyId], [true, keyId]);
  assert.ok(!JSON.stringify(s.obj).includes('lantern'), 'the password is not stored');
  assert.ok(!JSON.stringify(s.obj).includes('AGE-SECRET-KEY'), 'the private key is not stored unlocked');
});

test('without /proc: the launch gate first, running boxes written down then paused, any listing failure or late box spoils the copy', async () => {
  const { holdBoxes } = require('../lib/backup/create');
  const stateFile = path.join(TMP, 'r5', 'paused.json');
  const fake = (state) => (cmd, args) => {
    state.calls.push(args.join(' '));
    if (args[0] === 'ps') { if (state.psFails && state.calls.filter(c => c.startsWith('ps')).length > (state.psFailsAfter || 0)) return { status: 1 }; return { status: 0, stdout: (args.includes('-a') ? state.all : state.running()).join('\n') }; }
    if (args[0] === 'pause') { state.recordAtPause = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')).ids : null; return { status: state.pauseFails ? 1 : 0 }; }
    return { status: state.unpauseFails ? 1 : 0 };
  };
  let held = 0;
  const gate = async () => { held++; const letGo = () => { held--; }; return letGo; };
  assert.deepStrictEqual(await (async () => { const st = { calls: [], all: [], running: () => [] }; await (await holdBoxes('linux', fake(st), { procOk: true }))(); return st.calls; })(), [], 'Linux with /proc checks each file instead');
  // a terminal backup (no gate) wherever Docker is present, even with no boxes yet: refused
  await assert.rejects(holdBoxes('darwin', fake({ calls: [], all: [], running: () => [] }), { procOk: false }), (e) => e.code === 'EBOXES' && /Settings/.test(e.message));
  // no boxes yet: the gate is still taken (a box created meanwhile would be seen), and let go after
  const st0 = { calls: [], all: [], running: () => [] };
  const rel0 = await holdBoxes('darwin', fake(st0), { gate, stateFile, procOk: false });
  assert.strictEqual(held, 1);
  await rel0();
  assert.strictEqual(held, 0);
  // boxes running: written down durably BEFORE pausing, let go after, the record removed
  const st = { calls: [], all: ['aaa', 'bbb', 'ccc'], running: () => (st.calls.includes('pause aaa bbb') ? [] : ['aaa', 'bbb']) };
  const release = await holdBoxes('darwin', fake(st), { gate, stateFile, procOk: false });
  assert.deepStrictEqual(st.recordAtPause, ['aaa', 'bbb'], 'the record exists before the pause');
  await release();
  assert.ok(st.calls.includes('unpause aaa bbb'));
  assert.ok(!fs.existsSync(stateFile));
  assert.strictEqual(held, 0);
  // a box that started during the copy: thrown away, boxes still let go
  const st2 = { calls: [], all: ['aaa', 'ccc'], running: () => (st2.calls.filter(c => c.startsWith('ps')).length > 2 ? ['ccc'] : ['aaa']) };
  const rel2 = await holdBoxes('darwin', fake(st2), { gate, stateFile, procOk: false });
  await assert.rejects(rel2(), (e) => e.code === 'EBOXES' && /started while the backup was copying/.test(e.message));
  assert.ok(st2.calls.includes('unpause aaa'));
  // the listing after the copy fails: not "nothing running", the copy is spoiled
  const st3 = { calls: [], all: ['aaa'], running: () => ['aaa'], psFails: true, psFailsAfter: 2 };
  const rel3 = await holdBoxes('darwin', fake(st3), { gate, stateFile, procOk: false });
  await assert.rejects(rel3(), (e) => e.code === 'EBOXES' && /could not be checked/.test(e.message));
  assert.strictEqual(held, 0);
  // pausing fails: let go, gate released, no backup
  await assert.rejects(holdBoxes('darwin', fake({ calls: [], all: ['aaa'], running: () => ['aaa'], pauseFails: true }), { gate, stateFile, procOk: false }), (e) => e.code === 'EBOXES');
  assert.strictEqual(held, 0);
  // letting go fails: said plainly; the record stays for the next start
  const st4 = { calls: [], all: ['aaa'], running: () => (st4.calls.includes('pause aaa') ? [] : ['aaa']), unpauseFails: true };
  const rel4 = await holdBoxes('darwin', fake(st4), { gate, stateFile, procOk: false });
  await assert.rejects(rel4(), (e) => /docker unpause aaa/.test(e.message));
  assert.ok(fs.existsSync(stateFile), 'kept for the next start to retry');
  fs.rmSync(stateFile, { force: true });
  // the gate timed out while starts under way finished: no backup
  const timedGate = async () => { const letGo = () => {}; letGo.timedOut = true; return letGo; };
  await assert.rejects(holdBoxes('darwin', fake({ calls: [], all: ['aaa'], running: () => [] }), { gate: timedGate, stateFile, procOk: false }), /busy starting for too long/);
  // the time limit passes during the copy: the boxes are let go at once (onTimeout), and the copy is not kept
  let onTimeout = null, letGo6 = null;
  const slowGate = async (o) => { onTimeout = o.onTimeout; letGo6 = () => {}; return letGo6; };
  const st6 = { calls: [], all: ['aaa'], running: () => (st6.calls.includes('pause aaa') ? [] : ['aaa']) };
  const rel6 = await holdBoxes('darwin', fake(st6), { gate: slowGate, stateFile, procOk: false });
  letGo6.timedOut = true; onTimeout();
  assert.strictEqual(st6.calls.filter(c => c === 'unpause aaa').length, 1, 'let go at the time limit');
  await assert.rejects(rel6(), /longer than agents can be kept waiting/);
  assert.strictEqual(st6.calls.filter(c => c === 'unpause aaa').length, 1, 'and only once');
  // an earlier record that can't be settled (Docker not answering for that box) is never overwritten: no new backup
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ ids: ['ddd111'] }));
  const notUp = { calls: [], all: ['aaa'], running: () => ['aaa'] };
  const fakeNotUp = (cmd, args) => (args[0] === 'inspect' ? { status: 1, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' } : fake(notUp)(cmd, args));
  await assert.rejects(holdBoxes('darwin', fakeNotUp, { gate, stateFile, procOk: false }), /earlier backup left agents' boxes paused/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).ids, ['ddd111'], 'the earlier record is kept');
  assert.strictEqual(held, 0);
  // the same record once its box is let go: settled, and the new backup goes ahead
  const fakeUp = (cmd, args) => (args[0] === 'inspect' ? { status: 0, stdout: 'false\n' } : fake({ calls: [], all: [], running: () => [] })(cmd, args));
  const rel7 = await holdBoxes('darwin', fakeUp, { gate, stateFile, procOk: false });
  await rel7();
  assert.ok(!fs.existsSync(stateFile));
  // what counts as gone: only Docker's own "no such container" for that id
  const { letGoRecorded } = require('../lib/backup/create');
  const answers = { aaa111: { status: 0, stdout: 'false' }, bbb222: { status: 1, stderr: 'Error: No such object: bbb222' }, ccc333: { status: 0, stdout: 'true' }, eee444: { status: 1, stderr: 'error during connect: no such file or directory' }, fff555: { error: new Error('timeout') } };
  const inspect = (ids) => (cmd, args) => (args[0] === 'inspect' ? answers[args[3]] : { status: 0 });
  for (const [ids, settled] of [[['aaa111', 'bbb222'], true], [['aaa111', 'ccc333'], false], [['eee444'], false], [['fff555'], false]]) {
    fs.writeFileSync(stateFile, JSON.stringify({ ids }));
    assert.strictEqual(letGoRecorded(stateFile, inspect(ids)), settled, ids.join(','));
    assert.strictEqual(fs.existsSync(stateFile), !settled);
  }
  // a record that can't be read or doesn't make sense is kept: never "nothing was paused"
  for (const bad of ['{not json', '{}', '{"ids":"aaa111"}', '{"ids":["aaa111","../x"]}', '{"ids":[7]}']) {
    fs.writeFileSync(stateFile, bad);
    assert.strictEqual(letGoRecorded(stateFile, inspect([])), false, bad);
    assert.ok(fs.existsSync(stateFile), `kept: ${bad}`);
  }
  fs.rmSync(stateFile, { force: true });
  assert.doesNotThrow(async () => (await holdBoxes('darwin', () => ({ error: Object.assign(new Error('no docker'), { code: 'ENOENT' }) }), { procOk: false }))(), 'no Docker: no boxed agents');
  await assert.rejects(holdBoxes('darwin', undefined, { procOk: false }), /A test tried to pause real agent boxes/, 'the real docker is refused inside the test runner');
  // the launch gate: a start under way finishes before the hold begins; new starts wait; one hold at a time; a time limit
  const { withLaunch, holdLaunches } = require('../lib/sandbox');
  let finishFirst; const first = withLaunch(() => new Promise((r) => { finishFirst = r; }));
  let holding = false; const h = holdLaunches({ timeoutMs: 60000 }).then((letGo) => { holding = true; return letGo; });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(holding, false, 'the hold waits for the start under way');
  finishFirst(); await first;
  const letGo = await h;
  let secondRan = false; const second = withLaunch(async () => { secondRan = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(secondRan, false, 'a new start waits while held');
  await assert.rejects(holdLaunches(), (e) => e.code === 'EBUSY', 'one hold at a time');
  letGo(); await second;
  assert.strictEqual(secondRan, true);
  const quick = await holdLaunches({ timeoutMs: 10 });
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(quick.timedOut, true, 'never held past its limit');
  // names a settings map keyed by agent name would drop are refused
  const agentsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agents.js'), 'utf8');
  assert.match(agentsSrc, /const RESERVED_NAMES = new Set\(\['constructor', 'prototype', '__proto__'\]\);/);
  assert.strictEqual((agentsSrc.match(/RESERVED_NAMES\.has\(/g) || []).length, 6, 'create, clone and rename check it');
  // the settings patch can't reach a prototype at any depth
  const { cleanPatch } = require('../lib/settings');
  const patch = cleanPatch(JSON.parse('{"__proto__":{"backup":{}},"providers":{"__proto__":{"apiKey":"x"},"openai":{"apiKey":"k","constructor":{"a":1}}},"theme":"dark"}'));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(patch)), { providers: { openai: { apiKey: 'k' } }, theme: 'dark' });
  assert.ok(!Object.prototype.hasOwnProperty.call(patch.providers, '__proto__'));
  assert.strictEqual({}.apiKey, undefined, 'nothing reached Object.prototype');
});


test('a new backup never takes the name of one this computer still records (kept only in a folder that is away)', async () => {
  const inst = makeInstall('names');
  const s = memSettings();
  await keys.setup('lantern orbit mellow cactus', { settings: s, logN: 15 });
  const now = new Date('2026-10-29T19:30:00Z');
  const a = await createBackup({ ...inst, settings: s, now, hub: { version: '5.8.1' } });
  fs.rmSync(a.places[0].file);   // gone from this computer, still on record (a copy elsewhere)
  const b = await createBackup({ ...inst, settings: s, now, hub: { version: '5.8.1' } });
  assert.notStrictEqual(b.name, a.name);
  assert.match(b.name, /-2\.age$/);
  assert.deepStrictEqual(places.index(inst.root).map(x => x.name).sort(), [a.name, b.name].sort(), 'both records kept');
});
