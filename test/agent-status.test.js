'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
// lib/ comes from a throwaway install (test/helpers/isolated-install.js), so nothing under the real data/ is touched.
const path = require('path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('agent-status-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const { statusExtras } = L('sdk-chat');

const known = new Set(['owner-agent', 'lead', 'helper']);
const virtuals = {
  'tw-lead-1-aa': { id: 'tw-lead-1-aa', model: 'm1', parent: 'lead', label: 'research' },
  'tw-tw-lead-1-aa-1-bb': { id: 'tw-tw-lead-1-aa-1-bb', model: 'm2', parent: 'tw-lead-1-aa' },
};
const getVirtual = (n) => virtuals[n] || null;
const ex = (name, turn) => statusExtras(name, { getVirtual, turn });

test('virtual worker gets worker/parent/label/model', () => {
  assert.deepStrictEqual(ex('tw-lead-1-aa'), { worker: true, parent: 'lead', label: 'research', model: 'm1' });
});
test('worker of a worker resolves to the root parent', () => {
  assert.deepStrictEqual(ex('tw-tw-lead-1-aa-1-bb'), { worker: true, parent: 'lead', label: '', model: 'm2' });
});
test('a released tw- id is a worker without parent; any other unknown name is a named agent (the agent list is cached)', () => {
  assert.deepStrictEqual(ex('tw-gone-1-cc'), { worker: true, parent: null, label: '', model: '' });
  assert.deepStrictEqual(ex('brand-new-agent'), {});
  assert.deepStrictEqual(ex('brand-new-agent', { origin: { kind: 'consultation', from: 'lead' } }), { consultedBy: 'lead' });
});
test('consulted named agent gets consultedBy; user turn / idle get {}', () => {
  assert.deepStrictEqual(ex('helper', { origin: { kind: 'consultation', from: 'lead' } }), { consultedBy: 'lead' });
  assert.deepStrictEqual(ex('helper', { origin: { kind: 'user' } }), {});
  assert.deepStrictEqual(ex('helper', { origin: { kind: 'consultation' } }), {});
  assert.deepStrictEqual(ex('helper', null), {});
});
test('named agents never get worker', () => {
  for (const n of known) assert.ok(!('worker' in ex(n, { origin: { kind: 'consultation', from: 'x' } })));
});
