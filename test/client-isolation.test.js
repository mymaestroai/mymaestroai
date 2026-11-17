'use strict';
// Security R2 (client side): the owner's Claude sign-in is never copied into an agent's box, and every Claude client the hub
// starts loads only the settings and MCP servers its class allows (lib/client-isolation).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
// lib/ comes from a throwaway copy of the install (test/helpers/isolated-install.js); nothing under the real data/ is touched.
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('client-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const ci = L('client-isolation');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// ── isolationFor / mergeInto / isMemberReachable ────────────────────────────────────────────────────────────────

const ALWAYS = { strictMcpConfig: true, settings: { disableClaudeAiConnectors: true }, env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } };

test('isolationFor: exact options for each class of agent', () => {
  assert.deepStrictEqual(ci.BOXED_CLIENT_BUILTINS, ['ToolSearch']);
  assert.deepStrictEqual(ci.isolationFor({ boxed: true }), { ...ALWAYS, settingSources: [], tools: ['ToolSearch'] });
  assert.deepStrictEqual(ci.isolationFor({ boxed: true, memberReachable: true }), { ...ALWAYS, settingSources: [], tools: ['ToolSearch'] });
  assert.deepStrictEqual(ci.isolationFor({ memberReachable: true }), { ...ALWAYS, settingSources: [] });
  assert.deepStrictEqual(ci.isolationFor({ internal: true }), { ...ALWAYS, settingSources: [] });
  // an admin-side host agent no member can reach: the account's own skills, no project/local settings, no settings-file hooks
  assert.deepStrictEqual(ci.isolationFor({}), { ...ALWAYS, settingSources: ['user'], managedSettings: { allowManagedHooksOnly: true } });
  assert.deepStrictEqual(ci.isolationFor(), { ...ALWAYS, settingSources: ['user'], managedSettings: { allowManagedHooksOnly: true } });
});

test('isolationFor: the returned allow-list and settings are fresh copies (a caller cannot widen the next turn)', () => {
  const a = ci.isolationFor({ boxed: true }); a.tools.push('Bash'); a.settings.x = 1; a.env.Y = '1';
  assert.deepStrictEqual(ci.isolationFor({ boxed: true }).tools, ['ToolSearch']);
  assert.deepStrictEqual(ci.isolationFor({ boxed: true }).settings, { disableClaudeAiConnectors: true });
  assert.deepStrictEqual(ci.BOXED_CLIENT_BUILTINS, ['ToolSearch']);
});

// Lead's review: a call site with no env of its own ran the client with process.env; the merged env must start from it,
// or the client would start without PATH and HOME and so without the sign-in.
test('mergeInto: with no env given, the client env is process.env plus the isolation variable', () => {
  const out = ci.mergeInto({ maxTurns: 1 }, ci.isolationFor({ internal: true }));
  assert.strictEqual(out.env.PATH, process.env.PATH);
  assert.strictEqual(out.env.HOME, process.env.HOME);
  assert.strictEqual(out.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
});

test('mergeInto keeps the existing settings and env keys and takes the isolation options', () => {
  const q = { model: 'm', settings: { autoMemoryEnabled: false }, env: { PATH: '/bin', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '9' }, tools: { type: 'preset', preset: 'claude_code' }, mcpServers: { 'agent-hub': {} } };
  const out = ci.mergeInto(q, ci.isolationFor({ memberReachable: true }));
  assert.deepStrictEqual(out.settings, { autoMemoryEnabled: false, disableClaudeAiConnectors: true });
  assert.deepStrictEqual(out.env, { PATH: '/bin', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '9', ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
  assert.strictEqual(out.strictMcpConfig, true);
  assert.deepStrictEqual(out.settingSources, []);
  assert.deepStrictEqual(out.tools, { type: 'preset', preset: 'claude_code' }, 'an unboxed agent keeps its tools');
  assert.strictEqual(out.model, 'm');
  assert.deepStrictEqual(q.settings, { autoMemoryEnabled: false }, 'the input is not modified');
  // boxed: the preset is replaced by the allow-list
  assert.deepStrictEqual(ci.mergeInto(q, ci.isolationFor({ boxed: true })).tools, ['ToolSearch']);
  // no settings or env on the input
  const bare = ci.mergeInto({ model: 'm' }, ci.isolationFor({ internal: true }));
  assert.deepStrictEqual(bare.settings, { disableClaudeAiConnectors: true });
  // no env on the input: the client keeps process.env (what it got before), plus the isolation variable
  assert.deepStrictEqual(bare.env, { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
});

test('isMemberReachable: a member owner, any sharing; not an admin-owned unshared agent', () => {
  const admins = new Set(['a1']);
  assert.strictEqual(ci.isMemberReachable({ name: 'x', owner: 'm1' }, admins), true, 'member-owned');
  assert.strictEqual(ci.isMemberReachable({ name: 'x', owner: 'a1', sharedWith: ['m2'] }, admins), true, 'shared');
  assert.strictEqual(ci.isMemberReachable({ name: 'x', owner: 'a1' }, admins), false, 'admin-owned, unshared');
  assert.strictEqual(ci.isMemberReachable({ name: 'x', owner: 'a1', sharedWith: [] }, admins), false);
  assert.strictEqual(ci.isMemberReachable({ name: 'x' }, admins), false, 'no owner (the admin side)');
  assert.strictEqual(ci.isMemberReachable({ name: 'x', owner: 'm1' }, ['a1']), true, 'admin ids as an array');
  assert.strictEqual(ci.isMemberReachable(null, admins), false);
});

test('a temporary worker takes its parent class (the parent record is classed, as handsForTurn resolves it)', () => {
  const admins = new Set(['a1']);
  const parents = { member: { name: 'p', owner: 'm1' }, shared: { name: 'p', owner: 'a1', sharedWith: ['m2'] }, admin: { name: 'p', owner: 'a1' } };
  assert.deepStrictEqual(ci.isolationForAgent(parents.member, { adminIds: admins, sandboxed: false }), ci.isolationFor({ memberReachable: true }));
  assert.deepStrictEqual(ci.isolationForAgent(parents.shared, { adminIds: admins, sandboxed: false }), ci.isolationFor({ memberReachable: true }));
  assert.deepStrictEqual(ci.isolationForAgent(parents.admin, { adminIds: admins, sandboxed: false }), ci.isolationFor({}));
  assert.deepStrictEqual(ci.isolationForAgent(parents.admin, { adminIds: admins, sandboxed: true }), ci.isolationFor({ boxed: true }));
  assert.deepStrictEqual(ci.isolationForAgent(parents.member, { adminIds: admins, sandboxed: true }), ci.isolationFor({ boxed: true, memberReachable: true }));
});

// ── handsForTurn: a boxed Claude agent is always hub hands ─────────────────────────────────────────────────────

test('handsForTurn: a sandboxed claude-sdk agent gets hub hands whatever its tools or the default say; others unchanged', async () => {
  fs.writeFileSync(path.join(ISO.data, 'agents.json'), JSON.stringify([
    { name: 'boxed-client', model: 'claude-sdk/claude-fable-5-1', sandbox: 'container', tools: 'client' },
    { name: 'boxed-inherit', model: 'claude-sdk/claude-fable-5-1', sandbox: 'container' },
    { name: 'open-client', model: 'claude-sdk/claude-fable-5-1', sandbox: 'off', tools: 'client' },
    { name: 'boxed-codex', model: 'codex-cli/gpt-6-astra', sandbox: 'container', tools: 'client' },
  ]));
  // The sandbox singleton of the throwaway copy: no real Docker is ever asked.
  const sb = L('sandbox').getSandbox();
  sb.available = async () => false;
  sb.ensure = async () => { throw new Error('no docker in this test'); };
  const { handsForTurn } = L('sdk-chat');
  const quiet = console.warn; console.warn = () => {};
  try {
    const setDefault = (v) => { L('settings').updateSettings({ toolsDefault: v }); assert.strictEqual(L('settings').getSetting('toolsDefault'), v, 'the throwaway copy\'s toolsDefault is set'); };
    for (const dflt of ['client', 'hub']) {
      setDefault(dflt);
      const a = await handsForTurn('boxed-client');
      assert.strictEqual(a.sandboxed, true);
      assert.strictEqual(a.mode, 'hub', `tools=client is ignored in a box (toolsDefault ${dflt})`);
      assert.strictEqual(a.withheld, true, 'no Docker: hands withheld, never a fallback');
      assert.strictEqual((await handsForTurn('boxed-inherit')).mode, 'hub', `toolsDefault ${dflt}, tools unset`);
    }
    setDefault('client');
    const open = await handsForTurn('open-client');
    assert.strictEqual(open.sandboxed, false);
    assert.strictEqual(open.mode, 'client', 'unboxed agents keep their setting');
    assert.strictEqual((await handsForTurn('boxed-codex')).mode, 'client', 'codex-cli is unchanged');
  } finally { console.warn = quiet; }
});

test('handsForTurn: when the box cannot be cleared of an old sign-in copy (ensure rejects ECREDPURGE) the hands are withheld and there is no box', async () => {
  // 'boxed-inherit' is a sandboxed claude-sdk agent of the previous test's agents.json (the agent list is cached per process)
  const sb = L('sandbox').getSandbox();
  sb.available = async () => true;
  let ensured = 0;
  sb.ensure = async () => { ensured++; throw Object.assign(new Error('An old copy of the Claude sign-in could not be removed from hub-agent-boxed-purge (still-present); this agent\'s tools stay off until it is.'), { code: 'ECREDPURGE' }); };
  sb.mountsFor = () => { throw new Error('mountsFor must not be reached when ensure fails'); };
  const { handsForTurn } = L('sdk-chat');
  const warns = []; const quiet = console.warn; console.warn = (...a) => warns.push(a.join(' '));
  try {
    const h = await handsForTurn('boxed-inherit');
    assert.strictEqual(ensured, 1);
    assert.strictEqual(h.sandboxed, true);
    assert.strictEqual(h.withheld, true, 'hands withheld');
    assert.strictEqual(h.box, null, 'no box is handed out');
    assert.strictEqual(h.mode, 'hub');
    assert.ok(warns.some(w => w.includes('boxed-inherit') && w.includes('could not be removed')), warns.join('|'));
  } finally { console.warn = quiet; }
});

// ── policy gate: a boxed agent's client may call only the hub's tools and the allow-list ─────────────────────────

function gateFor(agent) {
  const { createGate } = L('policy-gate');
  return createGate({ getAgent: async () => agent, approvalsOn: () => false, log: () => {} });
}

test('policy gate: boxed blocks every other tool before any other check; unboxed unchanged', async () => {
  const g = gateFor({ name: 'gp', category: 'primary' });
  const boxed = g.sdkHook({ agentName: 'gp', cwd: '/tmp', boxed: true });
  const plain = g.sdkHook({ agentName: 'gp', cwd: '/tmp' });
  const call = (hook, tool_name, tool_input = {}) => hook({ hook_event_name: 'PreToolUse', tool_name, tool_input });
  for (const t of ['Bash', 'Read', 'Task', 'Skill', 'WebFetch', 'mcp__claude_ai_Gmail__x', 'Agent', 'Workflow', 'mcp__other__Bash']) {
    const out = await call(boxed, t, { command: 'pwd', file_path: '/tmp/x' });
    assert.strictEqual(out.decision, 'block', `${t} is blocked in a box`);
    assert.strictEqual(out.reason, 'This tool is not available to an agent in a box.');
  }
  for (const t of ['mcp__hub__Bash', 'mcp__agent-hub__read_memory', 'ToolSearch']) {
    const out = await call(boxed, t, { command: 'pwd' });
    assert.notStrictEqual(out.reason, 'This tool is not available to an agent in a box.', `${t} passes the box check`);
    assert.deepStrictEqual(out, {}, `${t} is allowed`);
  }
  // unboxed agents: the same hook without `boxed` does not apply the box rule
  assert.deepStrictEqual(await call(plain, 'Read', { file_path: '/tmp/x' }), {});
  assert.deepStrictEqual(await call(plain, 'Skill', {}), {}, 'not blocked by the box rule');
  assert.deepStrictEqual(await call(boxed, 'mcp__hub__Bash', { command: 'pwd' }), {});
  assert.deepStrictEqual(await boxed({ hook_event_name: 'Other', tool_name: 'Bash' }), {}, 'other hook events untouched');
});

// ── source pins ────────────────────────────────────────────────────────────────────────────────────────────────

test('lib/sdk-chat.js: no in-box client (no prepare, wrapper, credentials copy or box cwd) and isolation applied to the main query', () => {
  const sdk = read('lib/sdk-chat.js');
  assert.ok(!/sb\.prepare\(|\.prepare\(recSb\)/.test(sdk), 'the sandbox prepare() is gone from the client path');
  assert.ok(!sdk.includes('pathToClaudeCodeExecutable: sandboxOpts'), 'no wrapper executable for the client');
  assert.ok(!sdk.includes('sandboxOpts'), 'no sandboxOpts at all');
  assert.ok(!/syncCredentials|wrapperPath/.test(sdk));
  assert.ok(sdk.includes('clientIsolation.isolationFor({ boxed: !!hands.sandboxed'), 'boxed comes from the turn\'s hands (a worker: its parent)');
  assert.ok(sdk.includes('clientIsolation.mergeInto(queryOptions, isolation)'));
  assert.ok(sdk.includes('boxed: !!hands.sandboxed, origin: options.origin'), 'the policy gate hook is told');
  assert.ok(sdk.includes("if (sandboxed && /^claude-sdk\\//.test(runModel)) mode = 'hub';"), 'handsForTurn forces hub hands');
});

test('every place that starts a Claude client routes its options through client-isolation', () => {
  const SITES = {
    'lib/sdk-chat.js': 1,
    'lib/dream.js': 1,
    'lib/model-discovery.js': 2,
    'lib/plan-usage.js': 1,
    'lib/welcome.js': 1,
    'scripts/diagnose-models.js': 1,
  };
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const rel = path.posix.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel); } else if (e.name.endsWith('.js')) files.push(rel); } };
  for (const d of ['lib', 'scripts', 'modules']) walk(d);
  files.push('server.js');
  const found = {};
  for (const f of files) {
    const src = read(f);
    const re = /\b(sdk|sdkModule)\.query\(\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      if (/^\s*(\/\/|\/?\*)/.test(src.slice(lineStart, m.index + 1))) continue;   // a comment
      found[f] = (found[f] || 0) + 1;
      // the options block (and the few lines before it) must carry the isolation
      const window = src.slice(Math.max(0, m.index - 700), m.index + 900);
      assert.ok(/isolationFor|mergeInto/.test(window), `${f}: a Claude client is started without client-isolation near offset ${m.index}`);
    }
  }
  assert.deepStrictEqual(found, SITES, 'the list of places that start a Claude client changed: cover the new one with client-isolation and add it here');
  // dream passes the agent's own class
  const dream = read('lib/dream.js');
  assert.ok(dream.includes('clientIsolation.isolationForAgent(agent'), 'dream uses the agent\'s class');
  assert.ok(dream.includes('iso || clientIsolation.isolationFor({ internal: true })'), 'and the strictest class when it has none');
});

test('the gate hook and the allow-list live in one place (policy-gate imports the list from client-isolation)', () => {
  const pg = read('lib/policy-gate.js');
  assert.ok(pg.includes("require('./client-isolation')"));
  assert.ok(pg.includes('This tool is not available to an agent in a box.'));
});

test('agent-settings.html: the tools choice is fixed for a boxed agent on a Claude model, with the note', () => {
  const html = read('agent-settings.html');
  assert.ok(html.includes('Hub tools (always while this agent is in a box)'));
  assert.ok(html.includes('fixToolsWhileBoxed(agent);'));
  assert.match(html, /sel\.value = 'hub'; sel\.disabled = true;/);
  assert.match(html, /\/\^claude-sdk\\\/\/\.test\(agent\?\.model \|\| currentModel/);
});
