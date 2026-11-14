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
// lib/ comes from a throwaway install, so nothing under the real data/ is touched.
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('backup-create-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const fmt = L('backup/format');
const keys = L('backup/keys');
const places = L('backup/places');
const { createBackup } = L('backup/create');
const { readTar } = L('backup/tar');
const { encodeClaudeProject } = L('backup/collect');

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
  const r = await createBackup({ ...inst, _holdBoxes: () => () => {}, platform: 'linux', settings, places: [places.localPlace(inst.hubHome), places.folderPlace(folder)], hub: { version: '5.8.1', channel: 'experimental' } });
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
  const { holdBoxes } = L('backup/create');
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
  const { letGoRecorded } = L('backup/create');
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
  const { withLaunch, holdLaunches } = L('sandbox');
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
  const { cleanPatch } = L('settings');
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
  const a = await createBackup({ ...inst, _holdBoxes: () => () => {}, settings: s, now, hub: { version: '5.8.1' } });
  fs.rmSync(a.places[0].file);   // gone from this computer, still on record (a copy elsewhere)
  const b = await createBackup({ ...inst, _holdBoxes: () => () => {}, settings: s, now, hub: { version: '5.8.1' } });
  assert.notStrictEqual(b.name, a.name);
  assert.match(b.name, /-2\.age$/);
  assert.deepStrictEqual(places.index(inst.root).map(x => x.name).sort(), [a.name, b.name].sort(), 'both records kept');
});

// ── Docker installed but not running (a Mac with Docker Desktop closed): stand-ins for `docker`, the gate and the socket probe ──
const DD = (() => {
  const SOCK = '/Users/sam/.docker/run/docker.sock';
  const LINUX_DOWN = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n';
  const DENIED = 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: connect: permission denied\n';
  const DOWN = { status: 1, stdout: '', stderr: `failed to connect to the docker API at unix://${SOCK}; check if the path is correct and if the daemon is running: dial unix ${SOCK}: connect: no such file or directory\n` };
  const UP = (ids = '') => ({ status: 0, stdout: ids, stderr: '' });
  const TIMEOUT = { error: Object.assign(new Error('spawnSync docker ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null };
  // answers[n] answers the n-th `docker ps` (1-based; pinned or not); the context command answers with SOCK unless told otherwise
  function docker(answers, { context = () => ({ status: 0, stdout: `unix://${SOCK}\n` }) } = {}) {
    const calls = [], envs = []; let n = 0;
    const run = (cmd, args, o) => {
      calls.push(args.join(' ')); envs.push(o && o.env);
      if (args[0] === 'context') return context();
      if (args.includes('ps')) { n++; const a = answers[Math.min(n, answers.length) - 1]; return typeof a === 'function' ? a(args) : a; }
      return { status: 0 };
    };
    return { run, calls, envs };
  }
  const probeSays = (...answers) => { let i = 0; const seen = []; const f = async (p) => { seen.push(p); return answers[Math.min(i++, answers.length - 1)]; }; f.seen = seen; return f; };
  function mkGate() { const g = { held: 0, taken: 0, released: 0 }; g.fn = async () => { g.held++; g.taken++; return () => { g.held--; g.released++; }; }; return g; }
  const quiet = () => {};
  const base = (extra) => ({ procOk: false, env: {}, log: quiet, ...extra });
  return { SOCK, LINUX_DOWN, DENIED, DOWN, UP, TIMEOUT, docker, probeSays, mkGate, quiet, base };
})();
const keptOrWhy = async (rel) => { try { await rel(); return 'kept'; } catch (e) { return e; } };

test('Mac, Docker down, a gate: the gate is held for the copy, Docker asked again, kept when still down at the end on the same socket', async () => {
  const { holdBoxes } = L('backup/create');
  const g = DD.mkGate(); const d = DD.docker([DD.DOWN, DD.DOWN, DD.DOWN]); const logs = [];
  const rel = await holdBoxes('darwin', d.run, DD.base({ gate: g.fn, probeSocket: DD.probeSays('dead'), log: (m) => logs.push(m) }));
  assert.strictEqual(g.held, 1, 'held during the copy');
  assert.strictEqual(await keptOrWhy(rel), 'kept');
  assert.deepStrictEqual([g.held, g.taken, g.released], [0, 1, 1]);
  assert.ok(!d.calls.some(c => /^(pause|unpause)/.test(c)), 'nothing paused');
  assert.match(logs[0], /Docker isn't running on this Mac, so there are no running agent boxes to pause; the backup checks again at the end/);
  assert.ok(!logs.some(m => /no box can be running/i.test(m)));
});

test('the endpoint is the docker CLI\'s own answer, asked with the caller\'s environment (DOCKER_CONTEXT and DOCKER_HOST together: whatever the CLI reports)', () => {
  const { dockerEndpoint } = L('backup/create');
  const env = { DOCKER_CONTEXT: 'desktop-linux', DOCKER_HOST: 'unix:///tmp/pr74-a.sock' };
  const d = DD.docker([], { context: () => ({ status: 0, stdout: 'unix:///tmp/pr74-a.sock\n' }) });
  assert.deepStrictEqual(dockerEndpoint(d.run, { env, platform: 'darwin' }), { local: true, path: '/tmp/pr74-a.sock', from: 'cli' });
  assert.deepStrictEqual(d.calls, ['context inspect --format {{.Endpoints.docker.Host}}']);
  assert.strictEqual(d.envs[0], env, 'both variables reach the CLI unchanged; nothing is read from them by hand');
  const viaCtx = DD.docker([], { context: () => ({ status: 0, stdout: `unix://${DD.SOCK}\n` }) });
  assert.deepStrictEqual(dockerEndpoint(viaCtx.run, { env: { DOCKER_HOST: 'unix:///ignored.sock' }, platform: 'darwin' }), { local: true, path: DD.SOCK, from: 'cli' }, 'DOCKER_HOST is not read by hand');
  assert.deepStrictEqual(dockerEndpoint(DD.docker([], { context: () => ({ status: 0, stdout: 'ssh://me@box\n' }) }).run, { env: {}, platform: 'darwin' }), { local: false, from: 'cli' });
  assert.strictEqual(dockerEndpoint(DD.docker([]).run, { env: {}, platform: 'win32' }).local, false);
});

test('a failed or empty context inspection: the endpoint is unknown, never guessed, and the backup is refused', async () => {
  const { holdBoxes, dockerEndpoint } = L('backup/create');
  for (const context of [() => ({ status: 1, stdout: '', stderr: 'context "x": context not found' }), () => ({ status: 0, stdout: '\n' }), () => ({ error: new Error('ETIMEDOUT'), status: null })]) {
    assert.deepStrictEqual(dockerEndpoint(DD.docker([], { context }).run, { env: {}, platform: 'darwin' }), { local: false, from: 'unknown' });
    const p = DD.probeSays('dead'); const g = DD.mkGate();
    await assert.rejects(holdBoxes('darwin', DD.docker([DD.DOWN], { context }).run, DD.base({ gate: g.fn, probeSocket: p })), (e) => e.code === 'EBOXES');
    assert.deepStrictEqual(p.seen, [], 'no socket is probed');
    assert.strictEqual(g.held, 0);
  }
});

test('the end-of-copy check asks the pinned socket, even if the context would now answer differently', async () => {
  const { holdBoxes } = L('backup/create');
  let ctxCalls = 0;
  const d = DD.docker([DD.DOWN, DD.DOWN, DD.DOWN], { context: () => (++ctxCalls === 1 ? { status: 0, stdout: `unix://${DD.SOCK}\n` } : { status: 0, stdout: 'unix:///tmp/other.sock\n' }) });
  const p = DD.probeSays('dead');
  const rel = await holdBoxes('darwin', d.run, DD.base({ gate: DD.mkGate().fn, probeSocket: p }));
  assert.strictEqual(await keptOrWhy(rel), 'kept');
  assert.strictEqual(ctxCalls, 1, 'the context is asked once');
  const pinned = d.calls.filter(c => c.startsWith('-H '));
  assert.deepStrictEqual(pinned, [`-H unix://${DD.SOCK} ps -q -a --filter name=^hub-agent-`, `-H unix://${DD.SOCK} ps -q -a --filter name=^hub-agent-`], 'after the gate and at the end');
  assert.deepStrictEqual(p.seen, [DD.SOCK, DD.SOCK, DD.SOCK]);
});

test('Linux and Windows with a dead socket: refused as before; only a Mac takes the down path', async () => {
  const { holdBoxes } = L('backup/create');
  for (const platform of ['linux', 'win32']) {
    const g = DD.mkGate();
    await assert.rejects(holdBoxes(platform, DD.docker([DD.DOWN, DD.DOWN, DD.DOWN]).run, DD.base({ gate: g.fn, probeSocket: DD.probeSays('dead') })), (e) => e.code === 'EBOXES' && /could not be checked/.test(e.message), platform);
    assert.strictEqual(g.held, 0);
  }
  assert.strictEqual(await keptOrWhy(await holdBoxes('darwin', DD.docker([DD.DOWN, DD.DOWN, DD.DOWN]).run, DD.base({ gate: DD.mkGate().fn, probeSocket: DD.probeSays('dead') }))), 'kept');
});

test('no gate on the down path (a backup from a terminal): refused with the Settings message', async () => {
  const { holdBoxes } = L('backup/create');
  await assert.rejects(holdBoxes('darwin', DD.docker([DD.DOWN, DD.DOWN]).run, DD.base({ probeSocket: DD.probeSays('dead') })), (e) => e.code === 'EBOXES' && /Settings → Backups/.test(e.message));
});

test('Docker answering right after the gate is taken: refused (no switch to the normal path), the gate taken once and released once', async () => {
  const { holdBoxes } = L('backup/create');
  const g = DD.mkGate();
  const d = DD.docker([DD.DOWN, DD.UP('')]);
  await assert.rejects(holdBoxes('darwin', d.run, DD.base({ gate: g.fn, probeSocket: DD.probeSays('dead') })), (e) => e.code === 'EBOXES' && /Docker started just as the backup began, so the backup was not made\. Try again\./.test(e.message));
  assert.deepStrictEqual([g.held, g.taken, g.released], [0, 1, 1]);
  assert.ok(!d.calls.some(c => /^(pause|unpause)/.test(c)), 'nothing paused');
});

test('the pinned socket answers after the gate while the context now names another Docker: refused, nothing paused, no unpinned docker call after the gate', async () => {
  const { holdBoxes } = L('backup/create');
  let ctx = 0;
  // context A first (its socket dead), then the current context is switched to B
  const d = DD.docker([DD.DOWN, DD.UP('abc123\n'), DD.UP(''), DD.UP('')], { context: () => (++ctx === 1 ? { status: 0, stdout: `unix://${DD.SOCK}\n` } : { status: 0, stdout: 'unix:///tmp/pr74-b.sock\n' }) });
  const g = DD.mkGate();
  let atGate = -1;
  const gate = async (o) => { atGate = d.calls.length; return g.fn(o); };
  await assert.rejects(holdBoxes('darwin', d.run, DD.base({ gate, probeSocket: DD.probeSays('dead') })), (e) => e.code === 'EBOXES' && /Docker started just as the backup began/.test(e.message));
  const after = d.calls.slice(atGate);
  assert.deepStrictEqual(after, [`-H unix://${DD.SOCK} ps -q -a --filter name=^hub-agent-`], 'only the pinned check after the gate');
  assert.ok(!d.calls.some(c => /^(pause|unpause)/.test(c)), 'nothing paused');
  assert.strictEqual(ctx, 1, 'the context is not asked again');
  assert.deepStrictEqual([g.held, g.taken, g.released], [0, 1, 1]);
});

test('Docker answering at the end of the copy: not kept, with no boxes, only stopped boxes, or running boxes', async () => {
  const { holdBoxes } = L('backup/create');
  for (const ids of ['', 'abc123\n', 'abc123\ndef456\n']) {
    const g = DD.mkGate();
    const rel = await holdBoxes('darwin', DD.docker([DD.DOWN, DD.DOWN, DD.UP(ids)]).run, DD.base({ gate: g.fn, probeSocket: DD.probeSays('dead') }));
    const why = await keptOrWhy(rel);
    assert.ok(why instanceof Error && why.code === 'EBOXES' && /Docker started while the backup was copying, so agent activity during the copy could not be ruled out/.test(why.message), JSON.stringify(ids));
    assert.deepStrictEqual([g.held, g.released], [0, 1]);
  }
});

test('Docker neither down nor answering at the end (timeout, denied, starting, unknown): not kept', async () => {
  const { holdBoxes } = L('backup/create');
  for (const [end, sock] of [[DD.TIMEOUT, 'dead'], [{ status: 1, stdout: '', stderr: DD.DENIED }, 'denied'], [DD.DOWN, 'listening'], [DD.DOWN, 'unknown']]) {
    const g = DD.mkGate();
    const rel = await holdBoxes('darwin', DD.docker([DD.DOWN, DD.DOWN, end]).run, DD.base({ gate: g.fn, probeSocket: DD.probeSays('dead', 'dead', sock) }));
    const why = await keptOrWhy(rel);
    assert.ok(why instanceof Error && /could not be checked/.test(why.message), sock);
    assert.strictEqual(g.held, 0);
  }
});

test('a missing socket is dead; a stale non-socket file is dead or unknown, never listening; a probe that times out or is unsure is not down, and the backup is refused', async () => {
  const { probeSocket, holdBoxes } = L('backup/create');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr74-stale-'));
  try {
    assert.strictEqual(await probeSocket(path.join(dir, 'missing.sock'), 1500), 'dead', 'a missing path is dead');
    // a non-socket file left where the socket was: refused on Linux (dead), ENOTSOCK on a Mac (unknown); never listening
    const notASocket = path.join(dir, 'docker.sock'); fs.writeFileSync(notASocket, '');
    const said = await probeSocket(notASocket, 1500);
    assert.ok(said === 'dead' || said === 'unknown', said);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const g = DD.mkGate();
  await assert.rejects(holdBoxes('darwin', DD.docker([DD.DOWN]).run, DD.base({ gate: g.fn, probeSocket: DD.probeSays('unknown') })), (e) => e.code === 'EBOXES');
  assert.strictEqual(g.taken, 0);
});

test('"ran and failed" needs a numeric non-zero exit: a null status (killed by a signal) is refused, never down', async () => {
  const { holdBoxes, ranAndFailed } = L('backup/create');
  const killed = { status: null, signal: 'SIGKILL', stdout: '', stderr: '' };
  assert.strictEqual(ranAndFailed(killed), false);
  assert.strictEqual(ranAndFailed(DD.DOWN), true);
  const p = DD.probeSays('dead');
  await assert.rejects(holdBoxes('darwin', DD.docker([killed]).run, DD.base({ gate: DD.mkGate().fn, probeSocket: p })), (e) => e.code === 'EBOXES');
  assert.deepStrictEqual(p.seen, []);
});

test('the error text never decides: a remote endpoint (even one named docker.sock) or a listening socket with the classic text is refused; unknown wording with a dead socket is down', async () => {
  const { holdBoxes, dockerFailure } = L('backup/create');
  assert.strictEqual(dockerFailure({ status: 1, stderr: DD.LINUX_DOWN }), 'other');
  assert.strictEqual(dockerFailure({ status: 1, stderr: DD.DENIED }), 'denied');
  for (const host of ['tcp://10.0.0.5:2376', 'tcp://docker.sock.example.com:2376']) {
    const p = DD.probeSays('dead');
    const said = { status: 1, stdout: '', stderr: `Cannot connect to the Docker daemon at ${host}. Is the docker daemon running?\n` };
    await assert.rejects(holdBoxes('darwin', DD.docker([said], { context: () => ({ status: 0, stdout: `${host}\n` }) }).run, DD.base({ gate: DD.mkGate().fn, probeSocket: p })), (e) => e.code === 'EBOXES' && /`docker ps` works in a terminal/.test(e.message), host);
    assert.deepStrictEqual(p.seen, [], 'a remote endpoint is never probed');
  }
  await assert.rejects(holdBoxes('darwin', DD.docker([{ status: 1, stdout: '', stderr: DD.LINUX_DOWN }]).run, DD.base({ gate: DD.mkGate().fn, probeSocket: DD.probeSays('listening') })), (e) => e.code === 'EBOXES' && /Docker said: Cannot connect to the Docker daemon/.test(e.message));
  await assert.rejects(holdBoxes('darwin', DD.docker([{ status: 1, stdout: '', stderr: 'Impossible de se connecter\n' }]).run, DD.base({ gate: DD.mkGate().fn, probeSocket: DD.probeSays('denied') })), (e) => /permission denied on its socket/.test(e.message));
  for (const stderr of ['Impossible de se connecter au démon Docker\n', 'something unexpected\n', '']) {
    const odd = { status: 1, stdout: '', stderr };
    assert.strictEqual(await keptOrWhy(await holdBoxes('darwin', DD.docker([odd, odd, odd]).run, DD.base({ gate: DD.mkGate().fn, probeSocket: DD.probeSays('dead') }))), 'kept', JSON.stringify(stderr));
  }
  await assert.rejects(holdBoxes('darwin', DD.docker([DD.TIMEOUT]).run, DD.base({ gate: DD.mkGate().fn, probeSocket: DD.probeSays('dead') })), /didn't answer within 15 seconds/);
});

test('the gate on the down path: a time-out at the start or during the copy gives the normal messages, and the gate is always released', async () => {
  const { holdBoxes } = L('backup/create');
  let r1 = 0;
  const timed = async () => { const l = () => { r1++; }; l.timedOut = true; return l; };
  await assert.rejects(holdBoxes('darwin', DD.docker([DD.DOWN]).run, DD.base({ gate: timed, probeSocket: DD.probeSays('dead') })), /busy starting for too long/);
  assert.strictEqual(r1, 1);
  let l2 = null, r2 = 0;
  const late = async () => { l2 = () => { r2++; }; return l2; };
  const rel = await holdBoxes('darwin', DD.docker([DD.DOWN, DD.DOWN, DD.DOWN]).run, DD.base({ gate: late, probeSocket: DD.probeSays('dead') }));
  l2.timedOut = true;
  await assert.rejects(rel(), /longer than agents can be kept waiting/);
  assert.strictEqual(r2, 1);
  // a throw inside the down path still releases the gate: in the log line, and in the end check
  const g = DD.mkGate();
  await assert.rejects(holdBoxes('darwin', DD.docker([DD.DOWN, DD.DOWN]).run, DD.base({ gate: g.fn, probeSocket: DD.probeSays('dead'), log: () => { throw new Error('log broke'); } })), /log broke/);
  assert.deepStrictEqual([g.held, g.released], [0, 1]);
  const g2 = DD.mkGate();
  const rel2 = await holdBoxes('darwin', DD.docker([DD.DOWN, DD.DOWN, () => { throw new Error('run broke'); }]).run, DD.base({ gate: g2.fn, probeSocket: DD.probeSays('dead') }));
  await assert.rejects(rel2(), /could not be checked/);
  assert.deepStrictEqual([g2.held, g2.released], [0, 1]);
});

test('an earlier backup\'s record of paused boxes is byte-identical after a down-path backup; with Docker back and the record unsettled, refused', async () => {
  const { holdBoxes } = L('backup/create');
  const stateFile = path.join(TMP, 'r-docker-down', 'paused.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const rec = JSON.stringify({ ids: ['abc123def456'], at: '2026-11-04T08:30:00.000Z' });
  fs.writeFileSync(stateFile, rec);
  const d = DD.docker([DD.DOWN, DD.DOWN, DD.DOWN]); const logs = [];
  await (await holdBoxes('darwin', d.run, DD.base({ gate: DD.mkGate().fn, stateFile, probeSocket: DD.probeSays('dead'), log: (m) => logs.push(m) })))();
  assert.ok(!d.calls.some(c => /^(unpause|inspect)/.test(c)));
  assert.strictEqual(fs.readFileSync(stateFile, 'utf8'), rec);
  assert.match(logs[0], /record of boxes an earlier backup paused is kept/);
  const stuck = (cmd, args) => { if (args[0] === 'ps') return { status: 0, stdout: '' }; if (args[0] === 'inspect') return { status: 0, stdout: 'true\n' }; return { status: 0 }; };
  await assert.rejects(holdBoxes('darwin', stuck, DD.base({ gate: DD.mkGate().fn, stateFile, probeSocket: DD.probeSays('dead') })), /earlier backup left agents' boxes paused/);
  fs.rmSync(stateFile, { force: true });
});

test('unchanged: no Docker at all needs nothing; Docker running pauses and lets go running boxes and never probes; every docker call gets the same environment', async () => {
  const { holdBoxes } = L('backup/create');
  await (await holdBoxes('darwin', () => ({ error: Object.assign(new Error('spawnSync docker ENOENT'), { code: 'ENOENT' }) }), DD.base({ probeSocket: DD.probeSays('dead') })))();
  const env = { DOCKER_CONTEXT: 'desktop-linux' };
  const calls = [], envs = [];
  const up = (cmd, args, o) => { calls.push(args.join(' ')); envs.push(o && o.env); if (args[0] === 'ps') return { status: 0, stdout: 'abc123\n' }; return { status: 0 }; };
  const p = DD.probeSays('dead');
  const release = await holdBoxes('darwin', up, DD.base({ gate: DD.mkGate().fn, env, probeSocket: p }));
  assert.ok(calls.includes('pause abc123'));
  await release();
  assert.ok(calls.includes('unpause abc123'));
  assert.deepStrictEqual(p.seen, []);
  assert.ok(envs.length && envs.every(e => e === env), 'the same environment for every docker call');
});

test('createBackup through the down path end to end: kept when Docker stays down; not kept when it answers at the end (no partial file, nothing recorded)', async () => {
  const { holdBoxes } = L('backup/create');
  const settings = memSettings();
  await keys.setup('a down path passphrase', { settings, logN: 15 });
  const via = (answers) => (platform, _run, o) => holdBoxes(platform, DD.docker(answers).run, { ...o, env: {}, log: DD.quiet, probeSocket: DD.probeSays('dead') });
  const inst = makeInstall('down-kept'); const g = DD.mkGate();
  const r = await createBackup({ ...inst, platform: 'darwin', _procOk: false, gate: g.fn, _holdBoxes: via([DD.DOWN, DD.DOWN, DD.DOWN]), settings, hub: { version: '5.8.1' } });
  assert.ok(fs.existsSync(r.places[0].file));
  assert.deepStrictEqual([g.held, g.taken, g.released], [0, 1, 1]);
  const inst2 = makeInstall('down-spoiled'); const g2 = DD.mkGate();
  await assert.rejects(createBackup({ ...inst2, platform: 'darwin', _procOk: false, gate: g2.fn, _holdBoxes: via([DD.DOWN, DD.DOWN, DD.UP('')]), settings, hub: { version: '5.8.1' } }), (e) => e.code === 'EBOXES' && /agent activity during the copy could not be ruled out/.test(e.message));
  const dir = path.join(inst2.hubHome, 'backups');
  assert.deepStrictEqual(fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n !== 'index.json') : [], [], 'no backup, snapshot or partial file left');
  assert.deepStrictEqual(places.index(inst2.root), [], 'nothing recorded');
  assert.deepStrictEqual([g2.held, g2.released], [0, 1]);
});

test('probeSocket: a missing socket is dead, a listening one is listening (a throwaway socket under the test folder, never Docker\'s)', async () => {
  const { probeSocket } = L('backup/create');
  const net = require('net');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr74-sock-'));
  assert.strictEqual(await probeSocket(path.join(dir, 'missing.sock'), 1500), 'dead');
  const sockPath = path.join(dir, 'up.sock');
  const server = net.createServer((c) => c.destroy());
  await new Promise((r) => server.listen(sockPath, r));
  try { assert.strictEqual(await probeSocket(sockPath, 1500), 'listening'); }
  finally { await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});
