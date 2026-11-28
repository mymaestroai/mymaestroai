'use strict';
// A cd into a folder that exists and can be entered when the command is judged is taken to succeed, so a command joined
// after it with ; or a new line is judged in that folder only (and literal variables set after the cd are known there):
// `cd W && D=sub/..; cp f $D/x` is ordinary work. Every other step that can fail keeps the fail-closed reading, so
// `false && B=/tmp/x; cp f $B/etc/passwd` (B never set: the write lands in /etc) stays refused.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tp = require('../lib/tool-policy');
tp.setMemberProviders({ memberDefaults: () => ({}), ownerGrants: () => ({}) });

const X = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-chain-x-'));
fs.mkdirSync(path.join(X, 'sub'));
const worker = { name: 'torque', category: 'worker', policy: { roots: [X] } };
const cls = (command) => tp.decide({ agent: worker, tool: 'Bash', input: { command }, cwd: '/' }).cls;

test('cd into a folder that exists, then ; : later relative paths and variables are judged in that folder', () => {
  assert.equal(cls(`cd ${X} && D=sub/..; cp /dev/null $D/b5.txt`), 'write_inside', 'case 14');
  assert.equal(cls(`cd ${X} && D=${X}/sub; cp /dev/null "$D/b6.txt"`), 'write_inside');
  assert.equal(cls(`cd ${X} && true; cp /dev/null b.txt`), 'write_inside');
  assert.equal(cls(`cd ${X}\ncp /dev/null b2.txt`), 'write_inside', 'a new line joins like ;');
  assert.equal(cls(`cd ${X}; cp /dev/null b3.txt`), 'write_inside');
});

test('a cd that may fail, and every other failing step, keep the fail-closed reading', () => {
  assert.equal(cls(`false && B=${X}; cp /dev/null $B/etc/passwd`), 'admin', 'B is never set: the write lands in /etc');
  assert.equal(cls(`cd /nonexistent-folder-zz && B=${X}; cp /dev/null $B/etc/passwd`), 'admin', 'a cd into a missing folder may fail');
  assert.notEqual(cls(`cd ${X}/not-there; cp /dev/null b4.txt`), 'write_inside', 'a missing folder: judged in the starting folder too');
  assert.notEqual(cls(`cd ${X} || D=${X}/sub; cp /dev/null $D/b8.txt`), 'write_inside', 'an assignment in a || branch');
});

test('review: a cd is taken to succeed only when nothing earlier could have moved its folder, and never for a boxed agent', () => {
  assert.notEqual(cls(`mv ${X} ${X}.old; cd ${X}; cp /dev/null b.txt`), 'write_inside', 'mv first: the cd may fail');
  assert.notEqual(cls(`rmdir ${X}/sub && cd ${X}/sub; cp /dev/null b.txt`), 'write_inside', 'rmdir first');
  assert.notEqual(cls(`chmod 000 ${X}; cd ${X}; cp /dev/null b.txt`), 'write_inside', 'chmod first');
  assert.equal(cls(`echo start; cd ${X}; cp /dev/null b.txt`), 'write_inside', 'a harmless echo first is fine');
  const boxed = tp.decide({ agent: worker, tool: 'Bash', input: { command: `cd ${X}; cp /dev/null b.txt` }, cwd: '/', isBoxed: () => true }).cls;
  assert.notEqual(boxed, 'write_inside', 'a boxed agent: the box sees its own folders');
});
