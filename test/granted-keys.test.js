'use strict';
// Key files inside the folders granted to an agent (its workspace, agents[].policy.roots, a temporary worker's inherited grants)
// are its own: the key-NAME rule (id_ed25519, *.key, *.pem, *secret*...) does not make reading them an admin action there. The
// fixed places (~/.ssh, hub data, .env...) stay protected everywhere, and so does a key named file outside the grants.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tp = require('../lib/tool-policy');
const { workerRecord } = require('../lib/worker-grants');

const X = fs.mkdtempSync(path.join(os.tmpdir(), 'granted-keys-'));
const OTHER = fs.mkdtempSync(path.join(os.tmpdir(), 'granted-keys-other-'));
fs.writeFileSync(path.join(X, 'id_ed25519'), 'k');
fs.writeFileSync(path.join(X, 'deploy.key'), 'k');
fs.writeFileSync(path.join(OTHER, 'id_ed25519'), 'k');
fs.symlinkSync(path.join(OTHER, 'id_ed25519'), path.join(X, 'id_rsa_other'));   // a link in the grant to a key outside it
fs.symlinkSync(path.join(X, 'deploy.key'), path.join(X, 'same.key'));               // a link to a key inside the grant

const worker = (roots) => ({ name: 'torque', category: 'worker', ...(roots ? { policy: { roots } } : {}) });
const bash = (agent, command) => tp.decide({ agent, tool: 'Bash', input: { command }, cwd: '/tmp' });
const read = (agent, file_path) => tp.decide({ agent, tool: 'Read', input: { file_path }, cwd: '/tmp' });

test('inside a granted folder a key named file is the agent\'s own: ssh -i, cat, cp and the Read tool are not admin', () => {
  const a = worker([X]);
  assert.notEqual(bash(a, `ssh -i ${X}/id_ed25519 -p 22 pi@192.168.50.5 true`).cls, 'admin');
  assert.equal(bash({ ...a, localNetwork: true }, `ssh -i ${X}/id_ed25519 pi@192.168.50.5 true`).decision, 'allow');
  assert.equal(bash(a, `cat ${X}/deploy.key`).decision, 'allow');
  assert.equal(read(a, path.join(X, 'deploy.key')).decision, 'allow');
  assert.equal(bash(a, `cat ${X}/same.key`).decision, 'allow', 'a link to a key inside the grant');
});

test('the same paths without the grant stay admin', () => {
  const a = worker(null);
  assert.equal(bash({ ...a, localNetwork: true }, `ssh -i ${X}/id_ed25519 pi@192.168.50.5 true`).cls, 'admin');
  assert.equal(bash(a, `cat ${X}/deploy.key`).cls, 'admin');
  assert.equal(read(a, path.join(X, 'deploy.key')).cls, 'admin');
});

test('fixed places and keys outside the grant stay protected', () => {
  const a = worker([X]);
  assert.equal(bash(a, 'cat ~/.ssh/id_ed25519').cls, 'admin');
  assert.equal(bash(worker([path.join(os.homedir(), '.ssh')]), 'cat ~/.ssh/id_ed25519').cls, 'admin', 'granting ~/.ssh grants nothing');
  assert.equal(bash(a, `cat ${OTHER}/id_ed25519`).cls, 'admin', 'a key outside the grant (another folder under /tmp)');
  assert.equal(bash(a, `cat ${path.join(tp.HUB_HOME, 'share', 'someoneelse', 'id_ed25519')}`).cls, 'admin', 'another agent\'s Files folder');
  assert.equal(bash(a, `cat ${X}/id_rsa_other`).cls, 'admin', 'a link in the grant to a key outside it');
  assert.equal(bash(a, `cat ${X}/.env`).cls, 'admin', 'an .env file stays a secret everywhere');
});

test('the agent\'s own workspace counts; a member\'s and the wallet agent\'s keys follow the old rule', () => {
  const ws = path.join(tp.HUB_ROOT, 'workspaces', 'torque', 'id_ed25519');
  assert.notEqual(bash(worker(null), `cat ${ws}`).cls, 'admin');
  const member = { name: 'm', category: 'primary', owner: 'u1', policy: { roots: [X] } };
  assert.deepEqual(tp.policyFor(member, { isMemberOwned: () => true, memberDefaults: () => ({}), ownerGrants: () => ({}) }).keyRoots, []);
  const wallet = { name: 'w', category: 'worker', policy: { roots: [X] } };
  assert.deepEqual(tp.policyFor(wallet, { isWalletAgent: () => true }).keyRoots, []);
});

test('a temporary worker inherits its parent\'s granted folder and may use the key there', () => {
  const tmpWorker = workerRecord('torque-w1', worker([X]));
  assert.ok(tp.policyFor(tmpWorker).keyRoots.includes(path.resolve(X)));
  assert.equal(bash(tmpWorker, `cat ${X}/deploy.key`).decision, 'allow');
});

test('review: a .. through a linked folder, a failed lookup and a relative root give no exemption', () => {
  const a = worker([X]);
  fs.mkdirSync(path.join(OTHER, 'sub'), { recursive: true });
  fs.symlinkSync(path.join(OTHER, 'sub'), path.join(X, 'l'));   // X/l/.. is OTHER, whose id_ed25519 is outside the grant
  assert.equal(bash(a, `cat ${X}/l/../id_ed25519`).cls, 'admin', 'cat through a link and ..');
  assert.equal(read(a, `${X}/l/../id_ed25519`).cls, 'admin', 'Read through a link and ..');
  assert.equal(bash(a, `cd ${X}/l && cat ../id_ed25519`).cls, 'admin', 'cd into the link, then ..');
  const orig = fs.realpathSync;
  fs.realpathSync = (p, ...r) => { if (String(p).endsWith('deploy.key')) { const e = new Error('permission denied'); e.code = 'EACCES'; throw e; } return orig(p, ...r); };
  try { assert.equal(bash(a, `cat ${X}/deploy.key`).cls, 'admin', 'a lookup that fails other than "not there"'); } finally { fs.realpathSync = orig; }
  assert.equal(bash(worker(['tmp-relative']), `cat ${path.resolve('tmp-relative')}/id_ed25519`).cls, 'admin', 'a relative root is not counted');
});
