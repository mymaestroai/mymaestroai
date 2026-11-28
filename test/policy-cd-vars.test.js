'use strict';
// cd and `..`: bash's cd is logical by default (cd -L takes `..` off the path as written), so `cd X/link/..` lands in X and
// its operand is judged as typed; cd -P follows links first (kernelPath), so later relative paths are judged where it
// really lands (a loop or an unreadable step: from /, outside every agent's folders). A `..` path set in a variable earlier
// in the same command is judged like the path written out.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tp = require('../lib/tool-policy');
tp.setMemberProviders({ memberDefaults: () => ({}), ownerGrants: () => ({}) });   // never the install's own data/

const X = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-cd-x-'));
fs.mkdirSync(path.join(X, 'sub'));
fs.symlinkSync('/usr/bin', path.join(X, 'link'));          // X/link/.. is /usr to the kernel, X to bash's logical cd
fs.symlinkSync('loop2', path.join(X, 'loop1'));
fs.symlinkSync('loop1', path.join(X, 'loop2'));
const worker = { name: 'torque', category: 'worker', policy: { roots: [X] } };
const member = { name: 'mpal', category: 'primary', owner: 'u1', policy: { roots: [X] } };
const memberOpts = { isMemberOwned: () => true, memberDefaults: () => ({}), ownerGrants: () => ({}) };
const dec = (agent, command, extra = {}) => tp.decide({ agent, tool: 'Bash', input: { command }, cwd: X, ...extra });

test('cd -P through link/.. moves the tracked folder where the kernel goes: a later relative write is judged there', () => {
  assert.equal(dec(worker, 'cd -P link/.. && cp /dev/null out.txt').cls, 'admin');
  assert.equal(dec(worker, `cd -P ${X}/link/.. && cp /dev/null out.txt`).cls, 'admin');
  assert.equal(dec(worker, 'cd -L -P link/.. && cp /dev/null out.txt').cls, 'admin', 'the last of -L/-P counts');
  assert.equal(dec(worker, 'cd -P loop1/.. && cp /dev/null out.txt').cls, 'write_outside', 'a loop: judged from /');
  assert.equal(dec(worker, 'D=link/..; cd -P $D && cp /dev/null out.txt').cls, 'admin', 'the folder from a variable set earlier');
  assert.equal(dec(worker, 'cd -P sub/.. && cp /dev/null out.txt').cls, 'write_inside', 'through plain folders: as before');
});

test('a plain cd is logical: cd X/link/.. lands in X and is not judged through the link (a member\'s agent may do it)', () => {
  assert.equal(dec(worker, `cd ${X}/link/.. && ls`).cls, 'read');
  assert.equal(dec(member, `cd ${X}/link/.. && ls`, memberOpts).decision, 'allow');
  assert.equal(dec(worker, 'cd link/.. && cp /dev/null out.txt').cls, 'write_inside', 'bash lands in X, so the write is inside');
  assert.equal(dec(worker, 'cd -L link/.. && cp /dev/null out.txt').cls, 'write_inside');
  assert.equal(dec(worker, 'cd link && cp /dev/null ../out.txt').cls, 'admin', 'cp is a program: the kernel takes ../ from /usr/bin');
});

test('a .. path set in a variable earlier in the same command is judged where it lands', () => {
  assert.equal(dec(worker, `D=${X}/link/..; cp /dev/null $D/out.txt`).cls, 'admin');
  assert.equal(dec(worker, `D=${X}/link/.. && cp /dev/null "$D/out.txt"`).cls, 'admin');
  assert.equal(dec(worker, `D=${X}/sub/..; cp /dev/null $D/out.txt`).cls, 'write_inside', 'through plain folders: as before');
});
