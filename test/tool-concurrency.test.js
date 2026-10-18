'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const tc = require('../lib/tool-concurrency');
const sdkChat = require('../lib/sdk-chat');
const workerPolicy = require('../lib/worker-policy');

const EXPECTED = ['consult_agent', 'spawn_workers', 'list_agents', 'read_memory', 'read_session_notes', 'read_shared_memory',
  'search_shared_memory', 'run_job', 'job_status', 'job_cancel', 'list_jobs',
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];   // the hub's hands: reads and searches in parallel, as Claude Code does

test('the concurrency-safe set is exactly the agreed tools', () => {
  assert.deepStrictEqual([...tc.CONCURRENCY_SAFE_TOOLS].sort(), [...EXPECTED].sort());
});

test('isConcurrencySafe strips the MCP prefix and rejects everything else', () => {
  assert.strictEqual(tc.isConcurrencySafe('consult_agent'), true);
  assert.strictEqual(tc.isConcurrencySafe('mcp__agent-hub__consult_agent'), true);
  assert.strictEqual(tc.isConcurrencySafe('mcp__agent-hub__list_jobs'), true);
  for (const n of ['write_memory', 'ask_user', 'schedule_task', 'hl_order', 'mcp__agent-hub__write_memory', 'auth_http_request', '', undefined])
    assert.strictEqual(tc.isConcurrencySafe(n), false, String(n));
});

test('buildHubMcpServer takes its readOnlyHint from the module', async () => {
  const sdk = { tool: (name, description, shape, handler, opts) => ({ name, description, shape, handler, opts }), createSdkMcpServer: (o) => o };
  const server = await sdkChat.__askUser.buildHubMcpServer('zz_tool_concurrency', { on() {}, write() { return true; } }, sdk, { consultationDepth: 0 });
  assert.ok(server.tools.length > 10);
  for (const t of server.tools) {
    assert.strictEqual(t.opts?.annotations?.readOnlyHint === true, tc.isConcurrencySafe(t.name), t.name);
  }
  const names = new Set(server.tools.map(t => t.name));
  const HANDS = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);   // served by the "hub" hands server (lib/hub-tools), not agent-hub
  for (const n of EXPECTED) if (!HANDS.has(n)) assert.ok(names.has(n), n + ' is registered');
});

test('planBatches groups consecutive safe calls and isolates the rest', () => {
  const mk = (n) => ({ function: { name: n } });
  const plan = tc.planBatches([mk('consult_agent'), mk('read_memory'), mk('write_memory'), mk('consult_agent'), mk('ask_user'), mk('list_agents')])
    .map(b => b.map(c => c.function.name));
  assert.deepStrictEqual(plan, [['consult_agent', 'read_memory'], ['write_memory'], ['consult_agent'], ['ask_user'], ['list_agents']]);
});

test('ordered gate: safe calls overlap, unsafe calls run alone and in arrival order', async () => {
  const gate = tc.createOrderedGate();
  const log = [];
  let live = 0, peak = 0;
  const job = (label, ms) => async () => {
    log.push('+' + label); live++; peak = Math.max(peak, live);
    await new Promise(r => setTimeout(r, ms));
    live--; log.push('-' + label);
  };
  await Promise.all([
    gate.run('consult_agent', job('a', 30)),
    gate.run('consult_agent', job('b', 30)),
    gate.run('write_memory', job('w', 10)),
    gate.run('read_memory', job('c', 10)),
  ]);
  assert.ok(log.indexOf('+w') > log.indexOf('-a') && log.indexOf('+w') > log.indexOf('-b'), 'writer waits for earlier safe calls: ' + log);
  assert.ok(log.indexOf('+c') > log.indexOf('-w'), 'later safe call waits for the writer: ' + log);
  assert.ok(log.indexOf('+b') < log.indexOf('-a'), 'the first two overlapped: ' + log);
  assert.strictEqual(peak, 2);
});

test('ordered gate releases on failure', async () => {
  const gate = tc.createOrderedGate();
  await assert.rejects(gate.run('write_memory', async () => { throw new Error('boom'); }), /boom/);
  assert.strictEqual(await gate.run('write_memory', async () => 'ok'), 'ok');
});

test('one delegation text for every path, with bare tool names', () => {
  const t = workerPolicy.platformPolicyText([]);
  assert.match(t, /DELEGATION POLICY/);
  assert.doesNotMatch(t, /mcp__/);
  assert.match(t, /run together/);
  assert.ok(workerPolicy.policyText('fallback', []).startsWith(t));
  assert.ok(workerPolicy.policyText('off', []).startsWith(t));
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.strictEqual((src.match(/platformPolicyText\(/g) || []).length, 2, 'gateway and Codex use the shared text');
  assert.strictEqual((src.match(/workerPolicy\.policyText\(/g) || []).length, 1, 'only the SDK adds its sub-agent paragraph');
});
