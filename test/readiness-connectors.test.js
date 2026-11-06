'use strict';
// Readiness: the "connectors are now lead-only" line joins the checklist; a failing source adds nothing.
const { test } = require('node:test');
const assert = require('node:assert');
const { createReadiness } = require('../lib/readiness');

const base = { platform: 'linux', hasUsers: () => true, listUsers: () => [{ role: 'admin', totpEnabled: true, login: 'a' }], hasSdkCredentials: () => true,
  sandboxStatus: async () => ({ docker: true, imageReady: true }), fetchStatus: async () => ({ renderer: true, pdftotext: true }), searchChain: () => ['brave'], supervisor: () => 'systemd' };
const byId = (r, id) => r.items.find(i => i.id === id);

test('the lead-only connectors line joins the checklist as info with its link', async () => {
  const item = { id: 'connectors-open-to-all', level: 'info', title: 'Some data connectors are now lead-only', detail: 'Old open used to be available to every agent. Now only your lead agent can use them.', fix: 'Choose which other agents may use each one in Settings.', action: { label: 'Open data connectors', href: '/?connectors=1' } };
  const r = await createReadiness({ ...base, connectorItems: () => [item] }).check();
  assert.deepStrictEqual([byId(r, 'connectors-open-to-all').level, byId(r, 'connectors-open-to-all').action.href], ['info', '/?connectors=1']);
  assert.strictEqual(byId(await createReadiness({ ...base, connectorItems: () => [] }).check(), 'connectors-open-to-all'), undefined);
  const broken = await createReadiness({ ...base, connectorItems: () => { throw new Error('no file'); } }).check();
  assert.strictEqual(byId(broken, 'connectors-open-to-all'), undefined);
});
