'use strict';
// Setup checklist (lib/readiness): a warning when no phone or browser is set up for admins' notices.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { createReadiness } = require('../lib/readiness');

const base = {
  platform: 'linux', hasUsers: () => true, listUsers: () => [], setupNeeded: () => false, agents: async () => [],
  sandboxStatus: async () => ({ docker: true, imageReady: true }), fetchStatus: async () => ({ renderer: true, pdftotext: true }),
  searchChain: () => ['duckduckgo'], supervisor: () => 'systemd', which: async () => true,
};
const item = async (over) => (await createReadiness({ ...base, ...over }).check()).items.find(i => i.id === 'push-devices');

test('no admin device for notices: one warning with the fix in plain words', async () => {
  const it = await item({ adminPushDevices: () => 0 });
  assert.ok(it, 'listed');
  assert.strictEqual(it.level, 'warn');
  assert.strictEqual(it.title, 'No phone or browser is set up to receive notices');
  assert.strictEqual(it.fix, "Turn on notifications in the phone app's menu.");
  assert.match(it.detail, /reach nobody/);
});

test('a device, an unknown count, or a count that fails: no warning', async () => {
  assert.strictEqual(await item({ adminPushDevices: () => 1 }), undefined);
  assert.strictEqual(await item({ adminPushDevices: async () => 3 }), undefined);
  assert.strictEqual(await item({ adminPushDevices: () => null }), undefined);
  assert.strictEqual(await item({}), undefined, 'the default says nothing');
  assert.strictEqual(await item({ adminPushDevices: () => { throw new Error('unreadable'); } }), undefined);
});

test('the hub counts admins\' devices and devices registered before accounts, not members\'', () => {
  const src = fs.readFileSync(require.resolve('../lib/readiness'), 'utf8');
  assert.match(src, /adminPushDevices: \(\) => \{ try \{ return require\('\.\/push'\)\.getPush\(\)\.subscriptions\(\)\.filter\(s => !s\.user \|\| s\.user\.role === 'admin'\)\.length; \} catch \{ return null; \} \}/);
});
