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
