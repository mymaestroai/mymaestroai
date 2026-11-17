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

// Review r2 (GPT-5.6): the turn's boxed flag must reach the policy on every path that runs hands in a box, not only the
// Claude client's hook: the gateway pre-step and the Codex bridge's beforeCall (a temporary worker on those models runs
// in its parent's box while its own record has no sandbox field).
test('gateway and Codex paths pass the turn\'s boxed flag (and the hands\' folder) to the policy gate', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(src, /handlers\.__boxed = !!hands\.sandboxed;/, 'the gateway handlers carry the turn\'s boxed flag');
  assert.match(src, /gate\.check\(\{ agentName, tool: toolName, input: parsedArgs, cwd: \(handlers && handlers\.__cwd\) \|\| process\.cwd\(\), boxed: !!\(handlers && handlers\.__boxed\),/);
  assert.match(src, /beforeCall: \(name, args\) => gate\.check\(\{ agentName, tool: name, input: args, cwd: hubHands \? hands\.tools\.cwd : cwd, boxed: !!hands\.sandboxed,/);
  const checks = src.match(/gate\.check\(\{[^}]*\}/g) || [];
  assert.ok(checks.length >= 2 && checks.every(c => /boxed:/.test(c)), `every gate.check in sdk-chat passes boxed: ${checks.length}`);
});

test('a box that may still hold an old sign-in copy gets its own notice, not the Docker one', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  const start = src.indexOf('function sandboxWithheldNotice(');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  const f = new Function(`${body}\n}; return sandboxWithheldNotice;`)();
  assert.match(f('ECREDPURGE'), /old copy of your Claude sign-in could not be removed/);
  assert.doesNotMatch(f('ECREDPURGE'), /Install Docker/);
  assert.match(f(null), /Docker or the sandbox image is missing/);
  assert.match(src, /withheldCode = \(e && e\.code\) \|\| null;/);
  assert.match(src, /sandboxWithheldNotice\(hands\.withheldCode\)/);
});

// R2 regression (live 10:31, 11-17): the client accepts edits in acceptEdits only inside its working folder (the install
// root) and asked, unanswerably, for a Write anywhere else (share/, medical/, legal/). The hub's policy decides: its 'allow'
// for the client's own file writers is now passed on as an explicit permissionDecision 'allow'.
test('client Write/Edit outside the working folder: an allowed call answers permissionDecision allow; a denied one is still blocked; other tools unchanged; policy off unchanged', async () => {
  const lead = { name: 'lead-a', category: 'primary', lead: true };
  const g = gateFor(lead);
  const hook = g.sdkHook({ agentName: 'lead-a', cwd: '/opt/fake-install' });
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    const r = await hook(pre(tool, { file_path: '/opt/fake-home/share/lead-a/out.txt', content: 'x', old_string: 'a', new_string: 'b', notebook_path: '/opt/fake-home/share/lead-a/n.ipynb' }));
    assert.deepStrictEqual(r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision, 'allow', `${tool}: explicit allow`);
    assert.strictEqual(r.hookSpecificOutput.hookEventName, 'PreToolUse');
  }
  assert.deepStrictEqual(await hook(pre('Read', { file_path: '/opt/fake-home/share/lead-a/out.txt' })), {}, 'other tools: no explicit decision, as before');
  assert.deepStrictEqual(await hook(pre('mcp__hub__Write', { file_path: '/opt/fake-home/share/lead-a/out.txt', content: 'x' })), {}, 'the hub\'s own Write never needed it');
  // a worker writing into another agent's workspace: still blocked by the policy
  const worker = { name: 'w-1', category: 'worker' };
  const gw = gateFor(worker);
  const other = `${tp.HUB_ROOT}/workspaces/someone-else/x.txt`;
  const d = await gw.sdkHook({ agentName: 'w-1', cwd: tp.HUB_ROOT })(pre('Write', { file_path: other, content: 'x' }));
  assert.strictEqual(d.decision, 'block', 'a policy deny is still a block');
  assert.ok(!d.hookSpecificOutput, 'never an allow for a denied call');
  // the policy switched off: nothing explicit (the client's own rules apply, as before)
  const off = createGate({ getAgent: async () => lead, approvalsOn: () => false, log: () => {}, enabled: () => false });
  const o = await off.sdkHook({ agentName: 'lead-a', cwd: '/opt/fake-install' })(pre('Write', { file_path: '/opt/fake-home/share/lead-a/out.txt', content: 'x' }));
  assert.deepStrictEqual(o, {});
});
