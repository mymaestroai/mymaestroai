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

test('statusForViewer: activity naming a hidden caller is replaced; kept when the caller is accessible', () => {
  const out = X.statusForViewer(sam, { 'sam-agent': { busy: true, consultedBy: 'owner-agent', activity: 'consulted by owner-agent' } }, opts);
  assert.strictEqual(out['sam-agent'].activity, 'consulted by another agent');
  assert.ok(!('consultedBy' in out['sam-agent']));
  const out2 = X.statusForViewer(sam, { lead: { busy: true, consultedBy: 'sam-agent', activity: 'consulted by sam-agent' } }, opts);
  assert.strictEqual(out2.lead.activity, 'consulted by sam-agent');
  const out3 = X.statusForViewer(sam, { 'sam-agent': { busy: true, consultedBy: 'owner-agent', activity: 'writing' } }, opts);
  assert.strictEqual(out3['sam-agent'].activity, 'writing');
});

test('redactCaller: copy without caller name unless allowed', () => {
  const e = { busy: true, consultedBy: 'secret-agent', activity: 'consulted by secret-agent' };
  const r = X.redactCaller(e, () => false);
  assert.deepStrictEqual(r, { busy: true, activity: 'consulted by another agent' });
  assert.strictEqual(e.consultedBy, 'secret-agent', 'input untouched');
  assert.deepStrictEqual(X.redactCaller(e, (n) => n === 'secret-agent'), e);
  assert.notStrictEqual(X.redactCaller(e, () => true), e);
  assert.deepStrictEqual(X.redactCaller({ busy: false }, () => false), { busy: false });
});

test('redactTurnForViewer: hides a consultation caller the viewer cannot use', () => {
  const turn = { active: true, origin: { kind: 'consultation', from: 'secret-agent' }, activity: 'consulted by secret-agent', text: 'hi' };
  const r = X.redactTurnForViewer(turn, () => false);
  assert.deepStrictEqual(r.origin, { kind: 'consultation' });
  assert.strictEqual(r.activity, 'consulted by another agent');
  assert.strictEqual(r.text, 'hi');
  assert.strictEqual(turn.origin.from, 'secret-agent', 'input untouched');
  assert.strictEqual(X.redactTurnForViewer(turn, () => true), turn);
  const chat = { active: true, origin: { kind: 'chat' } };
  assert.strictEqual(X.redactTurnForViewer(chat, () => false), chat);
  assert.strictEqual(X.redactTurnForViewer(null, () => false), null);
});

test('canAccessAgent: a worker of a worker follows the chain to the named agent', () => {
  const v = { 'tw-a': { parent: 'tw-b' }, 'tw-b': { parent: 'sam-agent' }, 'tw-c': { parent: 'tw-d' }, 'tw-d': { parent: 'owner-agent' } };
  const o = { agents, resolveVirtual: (n) => v[n] || null };
  assert.strictEqual(X.canAccessAgent(sam, 'tw-a', o), true);
  assert.strictEqual(X.canAccessAgent(sam, 'tw-c', o), false);
  const loop = { agents, resolveVirtual: (n) => ({ parent: n === 'x' ? 'y' : 'x' }) };
  assert.strictEqual(X.canAccessAgent(sam, 'x', loop), false, 'a cycle ends');
});

test('server: token status branch and /turn redact the caller name', () => {
  const server = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(server.includes('access.redactCaller(e, (n) => req.hubToken.agents.includes(n))'));
  assert.ok(server.includes('access.redactTurnForViewer(turn, (n) => access.canAccessAgent(who, n, ctx))'));
});

test('statusForViewer: input not mutated; no user -> {}', () => {
  const input = feed();
  X.statusForViewer(sam, input, opts);
  assert.deepStrictEqual(input, feed());
  assert.deepStrictEqual(X.statusForViewer(null, feed(), opts), {});
  assert.deepStrictEqual(X.statusForViewer(sam, feed()), {}, 'no agents known -> nothing');
});
