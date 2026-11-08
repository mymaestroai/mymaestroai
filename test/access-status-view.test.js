'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const X = require('../lib/access');

const owner = { id: 'u_owner', role: 'admin' };
const sam = { id: 'u_sam', role: 'member' };
const agents = [
  { name: 'owner-agent', owner: 'u_owner' },
  { name: 'sam-agent', owner: 'u_sam' },
  { name: 'lead', owner: 'u_owner', sharedWith: ['u_sam'] },
];
const virtuals = { 'tw-sam-agent-1-aa': { parent: 'sam-agent' }, 'tw-owner-agent-1-bb': { parent: 'owner-agent' } };
const opts = { agents, resolveVirtual: (n) => virtuals[n] || null };
const feed = () => ({
  'owner-agent': { busy: true, consultedBy: 'sam-agent' },
  'sam-agent': { busy: true, consultedBy: 'owner-agent' },
  lead: { busy: false, consultedBy: 'lead' },
  'tw-sam-agent-1-aa': { busy: true, worker: true, parent: 'sam-agent' },
  'tw-owner-agent-1-bb': { busy: true, worker: true, parent: 'owner-agent' },
});

test('statusForViewer: admin sees everything unchanged, as a copy', () => {
  const input = feed();
  const out = X.statusForViewer(owner, input, opts);
  assert.deepStrictEqual(out, feed());
  assert.notStrictEqual(out, input);
  assert.notStrictEqual(out.lead, input.lead);
});

test('statusForViewer: member sees accessible agents and their workers only', () => {
  const out = X.statusForViewer(sam, feed(), opts);
  assert.deepStrictEqual(Object.keys(out).sort(), ['lead', 'sam-agent', 'tw-sam-agent-1-aa']);
});

test('statusForViewer: consultedBy dropped when the caller is not accessible, kept when it is', () => {
  const out = X.statusForViewer(sam, feed(), opts);
  assert.ok(!('consultedBy' in out['sam-agent']));
  assert.strictEqual(out['sam-agent'].busy, true);
  assert.strictEqual(out.lead.consultedBy, 'lead');
  const out2 = X.statusForViewer(sam, { lead: { busy: true, consultedBy: 'sam-agent' } }, opts);
  assert.strictEqual(out2.lead.consultedBy, 'sam-agent');
});

test('statusForViewer: input not mutated; no user -> {}', () => {
  const input = feed();
  X.statusForViewer(sam, input, opts);
  assert.deepStrictEqual(input, feed());
  assert.deepStrictEqual(X.statusForViewer(null, feed(), opts), {});
  assert.deepStrictEqual(X.statusForViewer(sam, feed()), {}, 'no agents known -> nothing');
});
