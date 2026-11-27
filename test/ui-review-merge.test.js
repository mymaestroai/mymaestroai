'use strict';
// "For your review": one condition shows once. The Claude sign-in problem (three producers) and the admin two-factor warning (setup
// checklist + security check) each become ONE item; the gear count follows. Offline.
const test = require('node:test');
const assert = require('node:assert');
const R = require('../lib/ui-review.js');
const { plural, word } = require('../lib/plural.js');

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);

const claudeInputs = (n) => ({
  readiness: { items: [{ id: 'claude-signin', level: 'critical', title: `${n} agents use the Claude client but it is not signed in`, detail: 'Agents on claude-sdk/ models need a Claude sign-in on this machine.', fix: 'Press Sign in again in Settings.' }] },
  health: { items: [
    { id: 'health-signin-claude', level: 'critical', title: `Claude is not signed in: ${n} agents can't answer`, detail: '', fix: 'Open Settings and sign in to Claude again.' },
    { id: 'health-claude-signedout', level: 'critical', title: "Claude is signed out on this computer: agents on Claude can't answer", detail: 'The Claude client on this computer has no sign-in.', fix: 'An admin can press Sign in again.', action: 'claude-signin' },
  ] },
  now: NOW,
});

test('three Claude sign-in producers -> one Fix now item with the agent count and the Sign in again fix', () => {
  const r = R.build(claudeInputs(3));
  const claude = r.problems.filter((p) => /claude|signin/i.test(p.id));
  assert.strictEqual(claude.length, 1, JSON.stringify(r.problems.map((p) => p.id)));
  assert.strictEqual(claude[0].title, "Claude is not signed in: 3 agents can't answer");
  assert.deepStrictEqual(claude[0].fix, { label: 'Sign in again', kind: 'claude-signin' });
  assert.strictEqual(claude[0].tier, 'fix');
  assert.strictEqual(claude[0].level, 'critical');
  assert.ok(claude[0].text, 'keeps a sentence of what is wrong');
});

test('the Claude sign-in item says "1 agent" for one agent, and the count on the gear drops from three to one', () => {
  const r = R.build(claudeInputs(1));
  assert.strictEqual(r.problems.length, 1);
  assert.strictEqual(r.problems[0].title, "Claude is not signed in: 1 agent can't answer");
  assert.deepStrictEqual([r.count, r.fix.length, r.worst], [1, 1, 'critical']);
  assert.strictEqual(R.gearLabel(r), 'Settings, 1 thing to fix');
});

test('the Claude sign-in merge works with only two of the three, and with the old "(s)" wording', () => {
  const only2 = R.build({ readiness: { items: [{ id: 'claude-signin', level: 'critical', title: '2 agent(s) use the Claude client but it is not signed in', detail: 'x.' }] }, health: { items: [{ id: 'health-claude-signedout', level: 'critical', title: 'Claude is signed out', action: 'claude-signin' }] }, now: NOW });
  assert.strictEqual(only2.problems.length, 1);
  assert.strictEqual(only2.problems[0].title, "Claude is not signed in: 2 agents can't answer");
  assert.deepStrictEqual(only2.problems[0].fix, { label: 'Sign in again', kind: 'claude-signin' });
  // no count anywhere: the signed-out line stands
  const none = R.build({ health: { items: [{ id: 'health-claude-signedout', level: 'critical', title: "Claude is signed out on this computer: agents on Claude can't answer", action: 'claude-signin' }] }, now: NOW });
  assert.strictEqual(none.problems.length, 1);
  assert.deepStrictEqual(none.problems[0].fix, { label: 'Sign in again', kind: 'claude-signin' });
});

test('a stale copy does not beat a fresh read of the same Claude sign-in problem', () => {
  const first = R.build(claudeInputs(3));
  const second = R.build({ ...claudeInputs(3), health: null, failed: ['health'], previous: first, now: NOW + 1000 });
  assert.strictEqual(second.problems.filter((p) => /claude|signin/i.test(p.id)).length, 1);
  assert.strictEqual(second.count, 1);
});

test('two-factor: the setup checklist and the security check make one item (the more severe tier wins, the fix is kept)', () => {
  const ready = { id: 'totp', level: 'warn', title: '1 admin account without two-factor', detail: 'Admins without two-factor: owner.', fix: 'Each admin: account menu.', action: { label: 'Open Users', href: '/users' } };
  const sec = { id: 'totp', level: 'warn', title: '1 admin account without two-factor', detail: 'A password alone opens an admin account: owner.', fix: 'Each admin: set up two-factor.' };
  const r = R.build({ readiness: { items: [ready] }, security: { items: [sec] }, now: NOW });
  assert.strictEqual(r.problems.length, 1);
  assert.strictEqual(r.problems[0].tier, 'worth');
  assert.strictEqual(r.problems[0].title, '1 admin account without two-factor');
  assert.deepStrictEqual(r.problems[0].fix, { label: 'Open Users', href: '/users' }, 'the fix of the item it replaced is kept');
  assert.strictEqual(r.count, 0, 'a warning does not count');
  // exposed: the security check says critical -> Fix now, once, counted once
  const exposed = R.build({ readiness: { items: [ready] }, security: { items: [{ ...sec, level: 'critical' }] }, now: NOW });
  assert.strictEqual(exposed.problems.length, 1);
  assert.deepStrictEqual([exposed.problems[0].tier, exposed.problems[0].level, exposed.count], ['fix', 'critical', 1]);
});

test('two-factor from one source only is untouched', () => {
  const r = R.build({ security: { items: [{ id: 'totp', level: 'warn', title: '2 admin accounts without two-factor' }] }, now: NOW });
  assert.deepStrictEqual(r.problems.map((p) => p.id), ['sec:totp']);
});

test('plural helper: real words by count', () => {
  assert.strictEqual(plural(1, 'agent'), '1 agent');
  assert.strictEqual(plural(3, 'agent'), '3 agents');
  assert.strictEqual(plural(0, 'file'), '0 files');
  assert.strictEqual(plural(1, 'admin account'), '1 admin account');
  assert.strictEqual(plural(2, 'admin account'), '2 admin accounts');
  assert.strictEqual(plural(2, 'box', 'boxes'), '2 boxes');
  assert.strictEqual(word(1, 'runs', 'run'), 'runs');
  assert.strictEqual(word(2, 'runs', 'run'), 'run');
});
