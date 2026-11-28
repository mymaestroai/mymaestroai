'use strict';
// A temporary worker (spawn_workers) inherits what the owner granted its parent agent: extra folders, per-class decisions and the
// home-network switch, never more than the parent (lib/worker-grants.js, used by the policy gate's getAgent in lib/sdk-chat.js).
// Runs against a throwaway install copy (test/helpers/isolated-install.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');

const inst = makeIsolatedInstall('worker-grants-');
const L = (m) => require(path.join(inst.lib, m));
const tp = L('tool-policy');
const WG = L('worker-grants');

const ROBOT = '/srv/robot-a';
const LAN = '192.168.50.5';
const W = 'tw-123abc';
const notBoxed = () => false;
const decide = (agent, tool, input, extra = {}) => tp.decide({ agent, tool, input, cwd: '/srv', isBoxed: notBoxed, ...extra });
const granted = () => ({ name: 'magellan', category: 'primary', policy: { roots: [ROBOT], overrides: { destroy: 'allow', send: 'allow', write_outside: 'ask', money: 'allow', admin: 'allow' } }, localNetwork: true });
const plain = () => ({ name: 'birch', category: 'primary' });
// the record the gate built before this change: worker role, the parent's owner, nothing else
const oldRecord = (parent) => ({ name: W, category: 'worker', owner: parent.owner || null, virtualOf: parent.name });

test('a worker of a parent with an extra folder writes and deletes there; the old record was refused', () => {
  const rec = WG.workerRecord(W, granted());
  assert.deepEqual(rec.policy.roots, [ROBOT]);
  const write = { file_path: `${ROBOT}/notes.txt`, content: 'x' };
  assert.equal(decide(rec, 'Write', write).decision, 'allow', 'inside the inherited folder');
  assert.equal(decide(oldRecord(granted()), 'Write', write).decision, 'deny', 'before: outside a worker\'s folders');
  const rm = { command: `rm ${ROBOT}/notes.txt` };
  assert.equal(decide(rec, 'Bash', rm).decision, 'allow', 'destroy allowed as for the parent');
  assert.equal(decide(oldRecord(granted()), 'Bash', rm).decision, 'deny', 'before: a worker never destroys');
});

test('a worker inherits the parent\'s per-class decisions and home-network switch', () => {
  const rec = WG.workerRecord(W, granted());
  assert.deepEqual(rec.policy.overrides, { destroy: 'allow', send: 'allow', write_outside: 'ask' });
  assert.equal(rec.localNetwork, true);
  const pol = tp.policyFor(rec);
  assert.equal(pol.role, 'worker');
  assert.equal(pol.rules.send, 'allow');
  assert.equal(pol.rules.write_outside, 'ask');
  assert.equal(pol.localNetwork, true);
  assert.equal(tp.policyFor(oldRecord(granted())).localNetwork, false, 'before: never on the home network');
  const ssh = { command: `ssh pi@${LAN} uptime` };
  const lanParent = { name: 'torque', category: 'worker', localNetwork: true };
  assert.equal(decide(WG.workerRecord(W, lanParent), 'Bash', ssh).decision, 'allow', 'the robot on the home network, as for the parent');
  assert.equal(decide(oldRecord(lanParent), 'Bash', ssh).decision, 'deny', 'before: send refused');
});

test('never inherited: money, admin, lead, root; a wallet parent gives nothing', () => {
  const p = { ...granted(), lead: true };
  const rec = WG.workerRecord(W, p);
  assert.equal(rec.policy.overrides.money, undefined);
  assert.equal(rec.policy.overrides.admin, undefined);
  assert.equal(rec.lead, undefined);
  const pol = tp.policyFor(rec);
  assert.equal(pol.role, 'worker');
  assert.equal(pol.rules.money, 'deny');
  assert.equal(pol.rules.admin, 'deny');
  assert.ok(!pol.roots.includes(tp.HUB_ROOT), 'the lead\'s own roots stay the lead\'s');
  const wallet = WG.workerRecord(W, granted(), { isWalletAgent: (n) => n === 'magellan' });
  assert.equal(wallet.policy, undefined);
  assert.equal(wallet.localNetwork, undefined);
  const unsure = WG.workerRecord(W, granted(), { isWalletAgent: () => { throw new Error('x'); } });
  assert.equal(unsure.policy, undefined, 'a wallet check that fails inherits nothing');
});

test('a worker of a plain parent is exactly the record it always was', () => {
  assert.deepEqual(WG.workerRecord(W, plain()), oldRecord(plain()));
  assert.deepEqual(WG.workerRecord(W, { ...plain(), owner: 'u_owner' }), oldRecord({ ...plain(), owner: 'u_owner' }));
  assert.deepEqual(WG.workerRecord(W, null), { name: W, category: 'worker' });
  assert.deepEqual(WG.workerRecord(W, { name: 'x', policy: { roots: 'nope', overrides: { send: 'sure' } }, localNetwork: 'yes' }), oldRecord({ name: 'x' }), 'malformed grants give nothing');
});

test('a member-owned parent\'s workers stay inside the member caps', () => {
  const parent = { name: 'pat-helper', category: 'primary', owner: 'u_member', policy: { roots: [ROBOT], overrides: { destroy: 'allow', admin: 'allow', send: 'allow', web: 'allow' } }, localNetwork: true };
  const rec = WG.workerRecord(W, parent);
  const isMemberOwned = (a) => a.owner === 'u_member';
  const pol = tp.policyFor(rec, { isMemberOwned, memberDefaults: () => ({}), ownerGrants: () => ({}) });
  assert.equal(pol.role, 'member');
  assert.equal(pol.rules.destroy, 'deny', 'members never destroy');
  assert.equal(pol.rules.admin, 'deny');
  assert.equal(pol.rules.money, 'deny');
  assert.equal(pol.rules.send, 'allow', 'a member-grantable class follows the parent');
  assert.equal(pol.localNetwork, false, 'a member\'s agent never gets the home network');
  const parentPol = tp.policyFor(parent, { isMemberOwned, memberDefaults: () => ({}), ownerGrants: () => ({}) });
  for (const k of Object.keys(pol.rules)) assert.equal(pol.rules[k], parentPol.rules[k], `${k}: never more than the parent`);
});

test('the gate judges the place a worker\'s commands run: the parent\'s own box setting comes along', () => {
  assert.equal(WG.workerRecord(W, { ...plain(), sandbox: 'off' }).sandbox, 'off');
  assert.equal(WG.workerRecord(W, { ...plain(), sandbox: 'container' }).sandbox, 'container');
  assert.equal(WG.workerRecord(W, { ...plain(), sandbox: 'inherit' }).sandbox, undefined, 'unset follows the same owner default as the parent');
});

test('the policy gate builds a worker\'s record with workerRecord', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(src, /return workerGrants\.workerRecord\(name, parent, \{ isWalletAgent: \(n\) => walletTools\.isWalletAgent\(n\) \}\);/);
  assert.ok(!src.includes("Roots are not inherited: a worker stays a worker"));
});
