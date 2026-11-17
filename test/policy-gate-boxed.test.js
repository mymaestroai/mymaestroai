'use strict';
// Security R2 review fixes in the policy gate: the turn's `boxed` flag reaches the policy (a temporary worker's record has no
// sandbox field), and the SDK hook is given the directory the hands use as cwd.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('policy-gate-boxed-');
const L = (p) => require(path.join(ISO.lib, p));
const tp = L('tool-policy');
tp.setMemberProviders({ memberDefaults: () => ({}), ownerGrants: () => ({}) });
const { createGate } = L('policy-gate');

const CRED = '/home/agent/.claude/.credentials.json';
const pre = (tool_name, tool_input) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input });
const gateFor = (agent) => createGate({ getAgent: async () => agent, approvalsOn: () => false, log: () => {} });

test('sdkHook({ boxed: true }) refuses the box\'s sign-in file for a worker record with no sandbox field; boxed: false is judged as before', async () => {
  // a synthetic temporary-worker record: nothing in it says "container"
  const worker = { name: 'tw-1', category: 'worker' };
  assert.strictEqual(worker.sandbox, undefined);
  assert.strictEqual(tp.decide({ agent: worker, tool: 'mcp__hub__Read', input: { file_path: CRED } }).cls, 'read_outside', 'the default boxed detection says unboxed');
  const g = gateFor(worker);

  const boxed = await g.sdkHook({ agentName: 'tw-1', cwd: '/tmp', boxed: true })(pre('mcp__hub__Read', { file_path: CRED }));
  assert.strictEqual(boxed.decision, 'block', 'refused');
  assert.match(boxed.reason, /^\[DENIED BY POLICY\]/);
  assert.match(boxed.reason, /credentials|hub data/);

  const plain = await g.sdkHook({ agentName: 'tw-1', cwd: '/tmp', boxed: false })(pre('mcp__hub__Read', { file_path: CRED }));
  assert.deepStrictEqual(plain, {}, 'unboxed: just a read outside the roots, which a worker may do: not judged by the box rule');
  assert.deepStrictEqual(await g.sdkHook({ agentName: 'tw-1', cwd: '/tmp' })(pre('mcp__hub__Read', { file_path: CRED })), {}, 'no flag: as before');

  // the decision itself (check): admin/deny for boxed, read_outside/allow otherwise
  const a = await g.check({ agentName: 'tw-1', tool: 'mcp__hub__Read', input: { file_path: CRED }, cwd: '/tmp', boxed: true });
  assert.strictEqual(a.allowed, false); assert.strictEqual(a.decision.cls, 'admin'); assert.strictEqual(a.decision.decision, 'deny');
  const b = await g.check({ agentName: 'tw-1', tool: 'mcp__hub__Read', input: { file_path: CRED }, cwd: '/tmp', boxed: false });
  assert.strictEqual(b.allowed, true); assert.strictEqual(b.decision.cls, 'read_outside');
  // only the exact value true counts
  const c = await g.check({ agentName: 'tw-1', tool: 'mcp__hub__Read', input: { file_path: CRED }, cwd: '/tmp', boxed: 'yes' });
  assert.strictEqual(c.decision.cls, 'read_outside', 'a truthy non-boolean does not box the call');
});

test('a boxed agent\'s relative Write path is judged against the cwd the hook is given: its workspace is inside its roots, the install root is not', async () => {
  // Pure path arithmetic: nothing under /opt is touched.
  const install = '/opt/beacon-r2-fake-install', ws = `${install}/workspaces/bx`;
  const agent = { name: 'bx', category: 'primary', sandbox: 'container', policy: { roots: [ws] } };
  const g = gateFor(agent);
  const cls = async (cwd) => (await g.check({ agentName: 'bx', tool: 'mcp__hub__Write', input: { file_path: 'notes.md', content: 'x' }, cwd, boxed: true })).decision;
  const inWs = await cls(ws);
  assert.strictEqual(inWs.cls, 'write_inside', 'cwd = the workspace: inside its roots');
  assert.strictEqual(inWs.detail.path, `${ws}/notes.md`);
  const inInstall = await cls(install);
  assert.strictEqual(inInstall.cls, 'write_outside', 'cwd = the install root: outside the roots');
  assert.strictEqual(inInstall.detail.path, `${install}/notes.md`);
  // through the hook, with the cwd the hook was built with
  const hookWs = await g.sdkHook({ agentName: 'bx', cwd: ws, boxed: true })(pre('mcp__hub__Write', { file_path: 'notes.md', content: 'x' }));
  assert.deepStrictEqual(hookWs, {});
  const strict = createGate({ getAgent: async () => ({ ...agent, category: 'worker' }), approvalsOn: () => false, log: () => {} });
  assert.deepStrictEqual(await strict.sdkHook({ agentName: 'bx', cwd: ws, boxed: true })(pre('mcp__hub__Write', { file_path: 'notes.md', content: 'x' })), {}, 'a worker: the workspace write is allowed');
  const refused = await strict.sdkHook({ agentName: 'bx', cwd: install, boxed: true })(pre('mcp__hub__Write', { file_path: 'notes.md', content: 'x' }));
  assert.strictEqual(refused.decision, 'block', 'a worker: the same relative path against the install root is write_outside and refused');
});

test('lib/sdk-chat.js: the SDK hook gets the hands\' directory (the workspace for a box) as its cwd', () => {
  const sdk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.ok(sdk.includes('gate.sdkHook({ agentName, cwd: hubHands ? hands.tools.cwd : process.cwd(), boxed: !!hands.sandboxed,'), 'cwd follows the hands');
  assert.ok(!sdk.includes('gate.sdkHook({ agentName, cwd: process.cwd()'), 'no longer the install root unconditionally');
});
