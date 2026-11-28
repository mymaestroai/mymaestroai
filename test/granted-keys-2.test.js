'use strict';
// Granted folders written with ~, ~<this user> or $HOME are expanded the same way everywhere policy.roots is read, a
// ~<another user> folder is never granted, and the command lockbox's per-command widening counts a key named file in
// the agent's own key folders as its own (tool-policy pathsOf keyRoots).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tp = require('../lib/tool-policy');
const { expandRoot, expandRoots } = require('../lib/hub-home');
const { resolveRoots } = require('../lib/folders');
const { workerRecord } = require('../lib/worker-grants');

const HOME = os.homedir();
const SUB = 'granted-keys-2-not-there';   // never created: a key folder's lookup that finds nothing counts as inside it
const worker = (roots) => ({ name: 'torque', category: 'worker', ...(roots ? { policy: { roots } } : {}) });
const bash = (agent, command) => tp.decide({ agent, tool: 'Bash', input: { command }, cwd: '/tmp' });

test('expandRoot fills in ~, $HOME, ${HOME} and ~<this user>, refuses ~<another user>, and leaves the rest as written', () => {
  const h = '/home/sam';
  assert.equal(expandRoot('~', h, 'sam'), h);
  assert.equal(expandRoot('~/robot', h, 'sam'), '/home/sam/robot');
  assert.equal(expandRoot('$HOME', h, 'sam'), h);
  assert.equal(expandRoot('$HOME/robot', h, 'sam'), '/home/sam/robot');
  assert.equal(expandRoot('${HOME}/robot', h, 'sam'), '/home/sam/robot');
  assert.equal(expandRoot(' ~sam/robot ', h, 'sam'), '/home/sam/robot');
  assert.equal(expandRoot('~sam', h, 'sam'), h);
  assert.equal(expandRoot('~owner/robot', h, 'sam'), null);
  assert.equal(expandRoot('~owner', h, 'sam'), null);
  assert.equal(expandRoot('~owner/x', h, ''), null, 'no user name known: no ~name is granted');
  assert.equal(expandRoot('/srv/robot', h, 'sam'), '/srv/robot');
  assert.equal(expandRoot('$HOMEX/robot', h, 'sam'), '$HOMEX/robot', 'only the whole word HOME');
  assert.equal(expandRoot('', h, 'sam'), null);
  assert.equal(expandRoot(7, h, 'sam'), null);
  assert.equal(expandRoot('$HOME/link/../keys', h, 'sam'), null, 'a .. part is never granted');
  assert.equal(expandRoot('/srv/a/../keys', h, 'sam'), null);
  assert.equal(expandRoot('/srv/a..b/keys', h, 'sam'), '/srv/a..b/keys', 'only a whole .. part');
  assert.deepEqual(expandRoots(['~/a', '~owner/b', '$HOME/c'], h, 'sam'), ['/home/sam/a', '/home/sam/c']);
});

test('policyFor: a $HOME or ${HOME} root is granted and is a key folder; ~<another user> is neither', () => {
  const p = tp.policyFor(worker(['$HOME/' + SUB, '${HOME}/' + SUB + '-b']));
  assert.ok(p.roots.includes(path.join(HOME, SUB)));
  assert.ok(p.roots.includes(path.join(HOME, SUB + '-b')));
  assert.ok(p.keyRoots.includes(path.join(HOME, SUB)));
  const q = tp.policyFor(worker(['~nobody-else-here/' + SUB]));
  assert.ok(!q.roots.some((r) => r.includes('nobody-else-here')), 'not granted, not even as a folder under the hub');
  assert.ok(!q.keyRoots.some((r) => r.includes('nobody-else-here')));
});

test('a worker may use a key in a folder granted as $HOME/...; the same key without the grant stays admin', () => {
  assert.notEqual(bash(worker(['$HOME/' + SUB]), `cat ~/${SUB}/id_ed25519`).cls, 'admin');
  assert.equal(bash(worker(null), `cat ~/${SUB}/id_ed25519`).cls, 'admin');
  assert.equal(bash(worker(['$HOME/' + SUB]), 'cat ~/.ssh/id_ed25519').cls, 'admin', 'a fixed secret place stays protected');
});

test('a temporary worker inherits a ~ or $HOME grant and may use the key there', () => {
  const tmpWorker = workerRecord('torque-w1', worker(['$HOME/' + SUB]));
  assert.ok(tp.policyFor(tmpWorker).keyRoots.includes(path.join(HOME, SUB)));
  assert.notEqual(bash(tmpWorker, `cat ~/${SUB}/deploy.key`).cls, 'admin');
});

test('the lockbox widening list (pathsOf) does not count a key in the agent\'s key folders as above its baseline', () => {
  const X = fs.mkdtempSync(path.join(os.tmpdir(), 'granted-keys-2-'));
  fs.writeFileSync(path.join(X, 'id_ed25519'), 'k');
  const keyRoots = tp.policyFor(worker([X])).keyRoots;
  assert.deepEqual(tp.pathsOf(`cat ${X}/id_ed25519`, { cwd: '/tmp', roots: [X], keyRoots, agentName: 'torque' }).reads, []);
  assert.deepEqual(tp.pathsOf(`cat ${X}/id_ed25519`, { cwd: '/tmp', roots: [X], agentName: 'torque' }).reads, [path.join(X, 'id_ed25519')], 'no key folders: as before');
  assert.ok(tp.pathsOf('cat ~/.ssh/id_ed25519', { cwd: '/tmp', roots: [X], keyRoots, agentName: 'torque' }).reads.length, 'a fixed secret place still widens');
  fs.writeFileSync(path.join(X, 'id_ed25519'), '');
});

test('resolveRoots expands $HOME and keeps a refused ~<another user> root in its place, as typed', () => {
  assert.deepEqual(resolveRoots(['$HOME/a', '~nobody-else-here/b', '~/c'], '/home/sam'), ['/home/sam/a', '~nobody-else-here/b', '/home/sam/c']);
});

test('review: a root with .. after a link grants neither the folder it spells nor the one the link reaches', () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'granted-keys-2-dd-'));
  for (const d of ['elsewhere/sub', 'elsewhere/keys', 'home/keys']) fs.mkdirSync(path.join(T, d), { recursive: true });
  fs.writeFileSync(path.join(T, 'elsewhere/keys/id_ed25519'), 'k');
  fs.writeFileSync(path.join(T, 'home/keys/id_ed25519'), 'k');
  fs.symlinkSync(path.join(T, 'elsewhere/sub'), path.join(T, 'home/link'));
  const a = worker([path.join(T, 'home/link') + '/../keys']);
  const p = tp.policyFor(a);
  assert.ok(!p.roots.some((r) => r.startsWith(T)) && !p.keyRoots.some((r) => r.startsWith(T)));
  assert.equal(bash(a, `cat ${T}/home/keys/id_ed25519`).cls, 'admin', 'the folder the text spells');
  assert.equal(bash(a, `cat ${T}/elsewhere/keys/id_ed25519`).cls, 'admin', 'the folder the link reaches');
});

test('the lockbox widening list (pathsOf) applies the policy check\'s .. rule: a key path through .. widens, as decide calls it admin', () => {
  const X = fs.mkdtempSync(path.join(os.tmpdir(), 'granted-keys-2-pdd-'));
  const O = fs.mkdtempSync(path.join(os.tmpdir(), 'granted-keys-2-pdd-other-'));
  fs.mkdirSync(path.join(O, 'sub'));
  fs.writeFileSync(path.join(X, 'id_ed25519'), 'k');
  fs.symlinkSync(path.join(O, 'sub'), path.join(X, 'link'));   // X/link/.. is O to the file system, X to a collapsed path
  const a = worker([X]);
  const keyRoots = tp.policyFor(a).keyRoots;
  const cmd = `cat ${X}/link/../id_ed25519`;
  assert.equal(bash(a, cmd).cls, 'admin', 'the policy check gives no exemption through ..');
  assert.ok(tp.pathsOf(cmd, { cwd: '/tmp', roots: [X], keyRoots, agentName: 'torque' }).reads.length, 'so the widening list names it too');
  assert.deepEqual(tp.pathsOf(`cat ${X}/id_ed25519`, { cwd: '/tmp', roots: [X], keyRoots, agentName: 'torque' }).reads, [], 'without .. the key stays the agent\'s own');
});

test('kernelPath follows links before .., as the kernel does; a loop, a missing folder and a file used as a folder are told apart', () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'granted-keys-2-kp-'));
  fs.mkdirSync(path.join(T, 'o/sub'), { recursive: true });
  fs.writeFileSync(path.join(T, 'o/f'), 'x');
  fs.mkdirSync(path.join(T, 'x'));
  fs.symlinkSync(path.join(T, 'o/sub'), path.join(T, 'x/link'));
  fs.symlinkSync('loop2', path.join(T, 'x/loop1'));
  fs.symlinkSync('loop1', path.join(T, 'x/loop2'));
  assert.deepEqual(tp.kernelPath(`${T}/x/link/../f`), { status: 'ok', path: `${T}/o/f` });
  assert.deepEqual(tp.kernelPath(`${T}/x/link/../new.txt`), { status: 'ok', path: `${T}/o/new.txt` }, 'a file it would create: in the real folder');
  assert.equal(tp.kernelPath(`${T}/x/loop1/../f`).status, 'loop');
  assert.equal(tp.kernelPath(`${T}/x/nothere/../f`).status, 'missing');
  assert.equal(tp.kernelPath(`${T}/o/f/../f`).status, 'unknown', 'a file used as a folder');
  assert.equal(tp.kernelPath('rel/../f').status, 'unknown');
});

test('the lockbox widening list opens a .. path where the file system takes it, nothing for a loop, as typed when a folder is missing', () => {
  const X = fs.mkdtempSync(path.join(os.tmpdir(), 'granted-keys-2-wl-'));
  const O = fs.mkdtempSync(path.join(os.tmpdir(), 'granted-keys-2-wl-other-'));
  fs.mkdirSync(path.join(O, 'sub'));
  fs.writeFileSync(path.join(O, 'id_ed25519'), 'k');
  fs.writeFileSync(path.join(X, 'id_ed25519'), 'k');
  fs.symlinkSync(path.join(O, 'sub'), path.join(X, 'link'));
  fs.symlinkSync('loop2', path.join(X, 'loop1'));
  fs.symlinkSync('loop1', path.join(X, 'loop2'));
  const a = worker([X]);
  const keyRoots = tp.policyFor(a).keyRoots;
  const of = (cmd) => tp.pathsOf(cmd, { cwd: '/tmp', roots: [X], keyRoots, agentName: 'torque' });
  assert.deepEqual(of(`cat ${X}/link/../id_ed25519`).reads, [path.join(O, 'id_ed25519')], 'the key the link reaches, not the folded X/id_ed25519');
  assert.deepEqual(of(`cat ${X}/loop1/../id_ed25519`).reads, [], 'a link loop opens nothing');
  assert.deepEqual(of(`cat ${X}/nothere/../id_ed25519`).reads, [path.join(X, 'id_ed25519')], 'a missing folder: as typed');
  assert.deepEqual(of(`cat ${X}/id_ed25519 ${X}/link/../id_ed25519`).reads.sort(), [path.join(O, 'id_ed25519'), path.join(X, 'id_ed25519')].sort(), 'also named plainly: both');
  // the policy check judges X/link/../out where it lands (O/out, outside these roots), so an approval of it opens that file
  assert.deepEqual(of(`cp /dev/null ${X}/link/../out.txt`).writes, [path.join(O, 'out.txt')]);
});
