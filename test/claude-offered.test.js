'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { claudeOffered } = require('../lib/claude-offered');

const SHA = 'a'.repeat(40);
const pkg = (v) => JSON.stringify({ dependencies: { '@anthropic-ai/claude-agent-sdk': v } });
const avail = (over = {}) => () => ({ available: true, remote: SHA, ...over });

test('an available update gives the Claude client version of the remote package.json (^ and ~ stripped)', async () => {
  const seen = [];
  const gitShow = (root, ref) => { seen.push([root, ref]); return pkg('^0.2.5'); };
  assert.equal(await claudeOffered({ root: '/r', updateStatus: avail(), gitShow }), '0.2.5');
  assert.deepEqual(seen, [['/r', SHA]]);
  assert.equal(await claudeOffered({ root: '/r', updateStatus: avail(), gitShow: () => pkg('~1.0.0') }), '1.0.0');
  assert.equal(await claudeOffered({ root: '/r', updateStatus: avail(), gitShow: () => pkg('2.3.4') }), '2.3.4');
  assert.equal(await claudeOffered({ root: '/r', updateStatus: avail(), gitShow: async () => pkg('3.4.5') }), '3.4.5', 'an async git stand-in works');
});

test('no update, no remote, or a remote that is not 40 hex chars gives null and runs no git', async () => {
  const boom = () => { throw new Error('must not run'); };
  assert.equal(await claudeOffered({ root: '/r', updateStatus: () => ({ available: false, remote: SHA }), gitShow: boom }), null);
  assert.equal(await claudeOffered({ root: '/r', updateStatus: () => ({ available: true, remote: null }), gitShow: boom }), null);
  for (const bad of ['abc', 'main', `${SHA}0`, `--${'a'.repeat(38)}`, 'g'.repeat(40), `${'a'.repeat(39)}\n`]) assert.equal(await claudeOffered({ root: '/r', updateStatus: avail({ remote: bad }), gitShow: boom }), null);
});

test('a version that is not plain x.y.z gives null', async () => {
  for (const v of ['latest', '^1.2', '>=1.0.0', '1.2.3-beta.1', '^1.2.3 || ^2', '', null, 5]) assert.equal(await claudeOffered({ root: '/r', updateStatus: avail(), gitShow: () => pkg(v) }), null);
  assert.equal(await claudeOffered({ root: '/r', updateStatus: avail(), gitShow: () => JSON.stringify({ dependencies: {} }) }), null);
});

test('never throws: bad json, a throwing or rejecting git, a throwing status', async () => {
  assert.equal(await claudeOffered({ root: '/r', updateStatus: avail(), gitShow: () => 'not json' }), null);
  assert.equal(await claudeOffered({ root: '/r', updateStatus: avail(), gitShow: () => { throw new Error('git'); } }), null);
  assert.equal(await claudeOffered({ root: '/r', updateStatus: avail(), gitShow: () => Promise.reject(new Error('git')) }), null);
  assert.equal(await claudeOffered({ root: '/r', updateStatus: () => { throw new Error('status'); } }), null);
  assert.equal(await claudeOffered(), null);
});

test('an async status (the real update check) answers with a promise of the version', async () => {
  assert.equal(await claudeOffered({ root: '/r', updateStatus: async () => ({ available: true, remote: SHA }), gitShow: () => pkg('^0.9.1') }), '0.9.1');
  assert.equal(await claudeOffered({ root: '/r', updateStatus: async () => { throw new Error('x'); }, gitShow: () => pkg('0.9.1') }), null);
});

test('the real git call is async execFile with cwd root and a 5 s timeout (no sync call blocks the hub)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'claude-offered.js'), 'utf8');
  assert.match(src, /execFile\('git', \['show', `\$\{ref\}:package\.json`\], \{ cwd: root, timeout: 5000/);
  assert.doesNotMatch(src, /execFileSync/);
});
