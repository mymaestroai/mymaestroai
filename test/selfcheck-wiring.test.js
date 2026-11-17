'use strict';
// The self-check's hub wiring: hidden check agents in temporal-workers, the one record resolver in sdk-chat, the gate's
// onDecision and its no-ask rule, exactly six tools, the result observers, runSelfCheckTurn (through the real chat route
// with the test streamer in place of a model), reserved names, the routes and the readiness item.
// lib/ comes from a throwaway install; lib/selfcheck itself is not used (the routes take it as an argument).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('selfcheck-wiring-iso-');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-wiring-')));
process.env.HUB_HALT_FILE = path.join(TMP, 'hub-halt.json');
delete process.env.HUB_AUTH_USERNAME; delete process.env.HUB_AUTH_PASSWORD;
const L = (p) => require(path.join(ISO.lib, p));
const tw = L('temporal-workers.js');
const tp = L('tool-policy.js');
const policyGate = L('policy-gate.js');
const access = L('access.js');
const { isLeadAgent } = L('agents.js');
const agentsLib = L('agents.js');
const hubHalt = L('hub-halt.js');
const HOME = tp.HUB_HOME, ROOT = tp.HUB_ROOT;

const OVERRIDES = { send: 'deny', web: 'deny', admin: 'deny', destroy: 'deny', money: 'deny' };
const record = (c, extra) => ({ name: `selfcheck-${c}`, model: 'claude-sdk/claude-haiku-5-5', effort: 'low', owner: null, policy: { roots: [path.join(HOME, 'selfcheck', c)], overrides: { ...OVERRIDES } }, ...extra });
const RECORDS = {
  lead: record('lead', { category: 'primary', lead: true, tools: 'client', sandbox: 'off' }),
  host: record('host', { category: 'specialist', tools: 'client', sandbox: 'off' }),
  boxed: record('boxed', { category: 'specialist', tools: 'hub', sandbox: 'container' }),
  shared: record('shared', { category: 'specialist', sharedWith: ['selfcheck:member'], tools: 'client', sandbox: 'off' }),
};
const SIX = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'];

let sdkChat, server, port;
before(async () => {
  port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  process.env.PORT = String(port);   // sdk-chat reads the hub port when it loads
  sdkChat = L('sdk-chat.js');
  // a stand-in for the hub's own HTTP listener: the check turn POSTs to it exactly as in production
  server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/chat/stream') { res.writeHead(404); return res.end(); }
    let b = ''; req.on('data', c => b += c); req.on('end', () => sdkChat.handleChatStream(JSON.parse(b), res, { service: true }).catch(() => { try { res.end(); } catch {} }));
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
});
after(() => {
  try { sdkChat && sdkChat.__turn.setTestStreamer(null); } catch {}
  try { hubHalt.getHubHalt().resume(); } catch {}
  server && server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const mkVirtual = (c, observe) => tw.createVirtual({ selfCheck: true, id: `selfcheck-${c}`, record: RECORDS[c], model: RECORDS[c].model, observe });
const cleanup = () => { for (const c of Object.keys(RECORDS)) tw.releaseVirtual(`selfcheck-${c}`); };

// ── 1. The four records and the policy ─────────────────────────────────────────
test('policy: every check record may write and read in both its folders, and may not touch call recordings', () => {
  for (const [c, rec] of Object.entries(RECORDS)) {
    for (const dir of [path.join(HOME, 'selfcheck', c), path.join(ROOT, 'workspaces', `selfcheck-${c}`)]) {
      const w = tp.decide({ agent: rec, tool: 'Write', input: { file_path: path.join(dir, 'x.txt') }, cwd: ROOT });
      assert.deepStrictEqual([w.decision, w.cls], ['allow', 'write_inside'], `${c}: write in ${dir}`);
      const r = tp.decide({ agent: rec, tool: 'Read', input: { file_path: path.join(dir, 'x.txt') }, cwd: ROOT });
      assert.strictEqual(r.decision, 'allow', `${c}: read in ${dir}`);
    }
    const rec3 = tp.decide({ agent: rec, tool: 'Read', input: { file_path: path.join(HOME, 'call-recordings', 'selfcheck-abc.txt') }, cwd: ROOT });
    assert.strictEqual(rec3.decision, 'deny', `${c}: call recordings`);
  }
  assert.strictEqual(tp.roleOf(RECORDS.lead, {}), 'lead');
});

// ── 2. temporal-workers ───────────────────────────────────────────────────────
test('temporal-workers: a check agent needs a valid id, refuses a duplicate, is found by isSelfCheck and is never listed', () => {
  cleanup();
  for (const bad of [undefined, 'selfcheck-other', 'tw-x', 'selfcheck-lead2', 'xselfcheck-lead']) {
    assert.throws(() => tw.createVirtual({ selfCheck: true, id: bad, record: RECORDS.lead, model: 'm' }), /self-check agent needs an id/, String(bad));
  }
  const seen = [];
  const v = mkVirtual('lead', (e) => seen.push(e));
  try {
    assert.strictEqual(v.id, 'selfcheck-lead');
    assert.strictEqual(v.parent, null);
    assert.strictEqual(v.toolScope, 'full');
    assert.strictEqual(v.selfCheck, true);
    assert.strictEqual(typeof v.observe, 'function');
    assert.ok(Object.isFrozen(v.record), 'the record is a frozen copy');
    assert.strictEqual(v.record.name, 'selfcheck-lead');
    assert.notStrictEqual(v.record, RECORDS.lead);
    assert.throws(() => mkVirtual('lead'), /already running/);
    assert.strictEqual(tw.isSelfCheck('selfcheck-lead'), true);
    assert.strictEqual(tw.isSelfCheck('selfcheck-host'), false);
    assert.strictEqual(tw.isSelfCheck('nobody'), false);
    assert.ok(tw.isVirtual('selfcheck-lead'));
    assert.deepStrictEqual(tw.listVirtual().filter(x => x.id === 'selfcheck-lead'), [], 'listVirtual hides check agents');
    const ordinary = tw.createVirtual({ parent: 'sam', model: 'm', toolScope: 'read', label: 'x' });
    try {
      assert.match(ordinary.id, /^tw-sam-\d+-[0-9a-f]{4}$/);
      assert.strictEqual(ordinary.parent, 'sam');
      assert.strictEqual(ordinary.toolScope, 'read');
      assert.strictEqual(tw.isSelfCheck(ordinary.id), false);
      assert.strictEqual(ordinary.record, undefined);
      assert.ok(tw.listVirtual().some(x => x.id === ordinary.id), 'an ordinary worker is still listed');
      assert.match(tw.workerContext(v), /created by the hub itself/);
    } finally { tw.releaseVirtual(ordinary.id); }
  } finally { cleanup(); }
  assert.strictEqual(tw.isSelfCheck('selfcheck-lead'), false, 'gone once released');
});

// ── 3. The gate ───────────────────────────────────────────────────────────────
function stubGate(extra = {}) {
  const asked = [], allowed = [], decisions = [];
  const approvals = { request: (a) => { asked.push(a); return { id: 'a1', promise: Promise.resolve({ decision: 'allow', by: 'owner' }) }; }, timeoutMs: 1000 };
  const allowances = { has: () => false, add: (k) => { allowed.push(k); } };
  const gate = policyGate.createGate({
    getAgent: async (n) => (n === 'selfcheck-lead' ? { ...RECORDS.lead } : { name: n, category: 'primary', lead: true, owner: null }),
    approvals, allowances, approvalsOn: () => true, log: () => {},
    isSelfCheck: (n) => n === 'selfcheck-lead',
    onDecision: (d) => decisions.push(d),
    ...extra,
  });
  return { gate, asked, allowed, decisions };
}

test('gate: an "ask" becomes a deny for a check agent (no card, no allowance); a real agent still gets its card', async () => {
  const s = stubGate();
  const out = '/opt/zz-selfcheck-outside.txt';   // a lead's write outside its folders is an "ask"
  const r = await s.gate.check({ agentName: 'selfcheck-lead', tool: 'Write', input: { file_path: out }, cwd: ROOT });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.decision.decision, 'deny');
  assert.strictEqual(r.decision.reason, 'self-check agents never ask');
  assert.deepStrictEqual(s.asked, [], 'no approval request');
  assert.deepStrictEqual(s.allowed, [], 'no allowance');
  const real = await s.gate.check({ agentName: 'real-lead', tool: 'Write', input: { file_path: out }, cwd: ROOT });
  assert.strictEqual(real.allowed, true);
  assert.strictEqual(s.asked.length, 1, 'a real agent is asked as before');
  // cards off: an "ask" used to be allowed silently; for a check agent it is still a deny
  const off = stubGate({ approvalsOn: () => false });
  assert.strictEqual((await off.gate.check({ agentName: 'selfcheck-lead', tool: 'Write', input: { file_path: out }, cwd: ROOT })).allowed, false);
  assert.strictEqual((await off.gate.check({ agentName: 'real-lead', tool: 'Write', input: { file_path: out }, cwd: ROOT })).allowed, true);
});

test('gate: onDecision hears every decision (allow, deny, ask-turned-deny, policy off, a boxed block) and decides with the record\'s role', async () => {
  const s = stubGate();
  const home = path.join(HOME, 'selfcheck', 'lead');
  const a = await s.gate.check({ agentName: 'selfcheck-lead', tool: 'mcp__hub__Read', input: { file_path: path.join(home, 'read.txt') }, cwd: ROOT });
  assert.strictEqual(a.decision.role, 'lead', 'the lead record gives the lead role');
  await s.gate.check({ agentName: 'selfcheck-lead', tool: 'Read', input: { file_path: path.join(HOME, 'call-recordings', 'selfcheck-n.txt') }, cwd: ROOT });
  await s.gate.check({ agentName: 'selfcheck-lead', tool: 'Write', input: { file_path: '/opt/zz-selfcheck-outside.txt' }, cwd: ROOT });
  assert.deepStrictEqual(s.decisions.map(d => [d.tool, d.decision]), [['mcp__hub__Read', 'allow'], ['Read', 'deny'], ['Write', 'deny']]);
  assert.strictEqual(s.decisions[0].cls, 'read');
  assert.strictEqual(s.decisions[0].agentName, 'selfcheck-lead');
  assert.ok(s.decisions[0].input && s.decisions[0].input.file_path.endsWith('read.txt'));
  assert.ok(/call recordings/.test(s.decisions[1].reason));
  assert.strictEqual(s.decisions[2].reason, 'self-check agents never ask');
  // policy switched off still reports
  const off = stubGate({ enabled: () => false });
  await off.gate.check({ agentName: 'selfcheck-lead', tool: 'Bash', input: { command: 'ls' }, cwd: ROOT });
  assert.deepStrictEqual(off.decisions.map(d => [d.decision, d.reason]), [['allow', 'policy disabled']]);
  // a boxed client's blocked tool is a decision too
  const boxed = stubGate();
  const hook = boxed.gate.sdkHook({ agentName: 'selfcheck-lead', cwd: ROOT, boxed: true });
  const blocked = await hook({ hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: { url: 'https://example.invalid' } });
  assert.strictEqual(blocked.decision, 'block');
  assert.deepStrictEqual(boxed.decisions.map(d => [d.tool, d.decision]), [['WebFetch', 'deny']]);
  // an observer that throws never changes a decision
  const bad = stubGate({ onDecision: () => { throw new Error('boom'); } });
  assert.strictEqual((await bad.gate.check({ agentName: 'selfcheck-lead', tool: 'Read', input: { file_path: path.join(home, 'x') }, cwd: ROOT })).allowed, true);
});

test('B1: the observer also hears the policy\'s own rule: ask for a check agent\'s ask (turned into a deny), allow and deny as they are', async () => {
  const s = stubGate();
  const home = path.join(HOME, 'selfcheck', 'lead');
  await s.gate.check({ agentName: 'selfcheck-lead', tool: 'Read', input: { file_path: path.join(home, 'read.txt') }, cwd: ROOT });
  await s.gate.check({ agentName: 'selfcheck-lead', tool: 'Read', input: { file_path: path.join(HOME, 'call-recordings', 'selfcheck-n.txt') }, cwd: ROOT });
  await s.gate.check({ agentName: 'selfcheck-lead', tool: 'Write', input: { file_path: '/opt/zz-selfcheck-outside.txt' }, cwd: ROOT });
  assert.deepStrictEqual(s.decisions.map(d => [d.decision, d.rule]), [['allow', 'allow'], ['deny', 'deny'], ['deny', 'ask']]);
  // a real agent's approved card: the outcome is allow, the rule was ask... for it the policy's decision is the plain "ask" too
  const real = stubGate();
  await real.gate.check({ agentName: 'real-lead', tool: 'Write', input: { file_path: '/opt/zz-selfcheck-outside.txt' }, cwd: ROOT });
  assert.deepStrictEqual(real.decisions.map(d => [d.decision, d.rule]), [['allow', 'ask']]);
});

test('B1: sdk-chat forwards the rule to the check agent\'s observer', async () => {
  cleanup();
  const events = [];
  mkVirtual('lead', (e) => events.push(e));
  try {
    const gate = sdkChat.__selfcheck.gate;
    await gate.check({ agentName: 'selfcheck-lead', tool: 'Write', input: { file_path: '/opt/zz-selfcheck-outside.txt' }, cwd: ROOT });
    await gate.check({ agentName: 'selfcheck-lead', tool: 'mcp__hub__Read', input: { file_path: path.join(HOME, 'selfcheck', 'lead', 'read.txt') }, cwd: ROOT });
    assert.deepStrictEqual(events.map(e => [e.decision, e.rule]), [['deny', 'ask'], ['allow', 'allow']]);
  } finally { cleanup(); }
});

test('gate: the PreToolUse hook gives a check agent the same explicit allow for a client Write as a real one', async () => {
  const s = stubGate();
  const hook = s.gate.sdkHook({ agentName: 'selfcheck-lead', cwd: ROOT });
  const file = path.join(HOME, 'selfcheck', 'lead', 'write.txt');
  const out = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file } });
  assert.strictEqual(out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepStrictEqual(s.decisions.map(d => d.decision), ['allow']);
});

test('sdk-chat gate: the real gate sees a check agent\'s own record and tells its observer; no card and no allowance', async () => {
  cleanup();
  const events = [];
  mkVirtual('lead', (e) => events.push(e));
  try {
    const gate = sdkChat.__selfcheck.gate;
    const ok = await gate.check({ agentName: 'selfcheck-lead', tool: 'mcp__hub__Read', input: { file_path: path.join(HOME, 'selfcheck', 'lead', 'read.txt') }, cwd: ROOT });
    assert.strictEqual(ok.decision.role, 'lead');
    const ask = await gate.check({ agentName: 'selfcheck-lead', tool: 'Write', input: { file_path: '/opt/zz-selfcheck-outside.txt' }, cwd: ROOT });
    assert.strictEqual(ask.allowed, false, 'allowed silently before: cards are off by default');
    assert.deepStrictEqual(events.map(e => [e.type, e.tool, e.decision]), [['decision', 'Read', 'allow'], ['decision', 'Write', 'deny']], 'tool names lose mcp__hub__');
    assert.strictEqual(events[1].reason, 'self-check agents never ask');
    assert.deepStrictEqual(sdkChat.getApprovals().list().filter(a => a.agent === 'selfcheck-lead'), []);
    assert.deepStrictEqual(sdkChat.getAllowances().list(), []);
    // an ordinary worker of nobody gets no observer call
    await gate.check({ agentName: 'zz_not_a_check_agent', tool: 'Read', input: { file_path: '/tmp/x' }, cwd: ROOT });
    assert.strictEqual(events.length, 2);
  } finally { cleanup(); }
});

// ── 4. Resolver sites, and where it must never reach ──────────────────────────────
test('turnAgentRecord: own record first, then a check agent\'s, else null', () => {
  cleanup();
  const R = sdkChat.__selfcheck;
  const own = { name: 'selfcheck-lead', category: 'specialist' };
  mkVirtual('lead');
  try {
    assert.strictEqual(R.turnAgentRecord('selfcheck-lead', [own]), own, 'an agent in the list wins');
    assert.strictEqual(R.turnAgentRecord('selfcheck-lead', []).lead, true);
    assert.strictEqual(R.turnAgentRecord('selfcheck-lead', []).name, 'selfcheck-lead');
    assert.strictEqual(R.turnAgentRecord('selfcheck-host', []), null);
  } finally { cleanup(); }
  const worker = tw.createVirtual({ parent: 'sam', model: 'm', toolScope: 'read' });
  try { assert.strictEqual(R.turnAgentRecord(worker.id, []), null, 'a temporary worker keeps its own mapping at each site'); }
  finally { tw.releaseVirtual(worker.id); }
});

test('sites: lead environment, effort, owner and hands follow the check agent\'s record; a worker is never a lead', async () => {
  cleanup();
  const R = sdkChat.__selfcheck;
  mkVirtual('lead'); mkVirtual('host'); mkVirtual('shared'); mkVirtual('boxed');
  const worker = tw.createVirtual({ parent: 'lead-of-someone', model: 'm', toolScope: 'read' });
  try {
    assert.strictEqual(R.leadFor('selfcheck-lead')({ name: 'x' }), true, 'record.lead true');
    assert.strictEqual(R.leadFor('selfcheck-host')({ name: 'x' }), false);
    assert.strictEqual(R.leadFor('selfcheck-shared')({ name: 'x' }), false);
    assert.strictEqual(R.leadFor(worker.id)({ name: 'x' }), false);
    assert.strictEqual(await R.agentEffort('selfcheck-host'), 'low');
    assert.strictEqual(await R.ownerOfAgent('selfcheck-shared'), null);
    const hands = await sdkChat.handsForTurn('selfcheck-host');
    assert.strictEqual(hands.agent && hands.agent.name, 'selfcheck-host', 'the hands belong to the check record');
    assert.strictEqual(hands.sandboxed, false);
    const boxed = await sdkChat.handsForTurn('selfcheck-boxed');
    assert.strictEqual(boxed.agent && boxed.agent.name, 'selfcheck-boxed');
    assert.strictEqual(boxed.sandboxed, true, 'the container record is boxed (withheld here: no Docker in the test)');
    // client isolation: a check agent shared with a member is member-reachable, the others are not
    const ci = L('client-isolation.js');
    assert.strictEqual(ci.isMemberReachable((await sdkChat.handsForTurn('selfcheck-shared')).agent, new Set(['admin-1'])), true);
    assert.strictEqual(ci.isMemberReachable(hands.agent, new Set(['admin-1'])), false);
    // a status read of a check agent with no parent does not throw
    assert.deepStrictEqual(sdkChat.statusExtras('selfcheck-lead', { getVirtual: (n) => tw.getVirtual(n) }), { worker: true, parent: null, label: '', model: RECORDS.lead.model });
  } finally { tw.releaseVirtual(worker.id); cleanup(); }
});

test('the resolver never reaches lead lists, members or the hub brief: a check agent is not a lead, and a member cannot reach it', () => {
  cleanup();
  mkVirtual('lead'); mkVirtual('shared');
  try {
    const agents = [{ name: 'main', category: 'primary', lead: true, owner: null }, { name: 'sam-bot', category: 'specialist', owner: 'user-m1' }];
    assert.strictEqual(isLeadAgent('selfcheck-lead', agents), false, 'not a lead while the check runs');
    assert.deepStrictEqual(agentsLib.leadAgentNames(agents), ['main']);
    assert.deepStrictEqual(agentsLib.ownerLeadNames(agents), ['main']);
    const member = { id: 'user-m1', role: 'member' };
    const opts = { agents, resolveVirtual: (n) => tw.getVirtual(n) };
    assert.strictEqual(access.canAccessAgent(member, 'selfcheck-shared', opts), false);
    assert.strictEqual(access.canAccessAgent(member, 'selfcheck-lead', opts), false);
    assert.strictEqual(access.canAccessAgent({ id: 'selfcheck:member', role: 'member' }, 'selfcheck-shared', opts), false, 'not even the synthetic id');
    assert.strictEqual(access.canAccessAgent({ id: 'a1', role: 'admin' }, 'selfcheck-shared', opts), true);
  } finally { cleanup(); }
  // the resolver is named only at its sites
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  const lines = src.split('\n');
  for (const needle of [/isLeadAgent\([^)]*turnAgentRecord/, /leadAgentNames\([^)]*turnAgentRecord/, /ownerLeadNames\([^)]*turnAgentRecord/, /canAccessAgent\([^)]*turnAgentRecord/, /consultAllowed\([^)]*turnAgentRecord/]) {
    assert.ok(!lines.some(l => needle.test(l)), `turnAgentRecord must not feed ${needle}`);
  }
});

// ── 6. Reserved names ─────────────────────────────────────────────────────────
test('names: create, rename and clone refuse the selfcheck- prefix', async () => {
  const msg = /Names starting with selfcheck- are kept for the hub's own checks\./;
  for (const n of ['selfcheck-x', 'selfcheck-lead', 'SelfCheck-Y']) {
    const c = await agentsLib.createAgent(n, 'claude-sonnet-4-6', 'p', [], 'specialist');
    assert.strictEqual(c.success, false); assert.match(c.error, msg, `create ${n}`);
    const r = await agentsLib.renameAgent('some_agent', n);
    assert.strictEqual(r.success, false); assert.match(r.error, msg, `rename ${n}`);
    const k = await agentsLib.cloneAgent('some_agent', n);
    assert.strictEqual(k.success, false); assert.match(k.error, msg, `clone ${n}`);
  }
  // an ordinary hyphenated name is judged as before (not by this rule)
  const ok = await agentsLib.renameAgent('some_agent', 'selfcheck_x');
  assert.ok(!msg.test(ok.error || ''), 'selfcheck_x is not the reserved prefix');
});

// ── 7. Exactly six tools ──────────────────────────────────────────────────────
test('tools: the disallow list for the Claude client and the hands server leave exactly Read, Write, Edit, Glob, Grep and Bash', () => {
  const dis = tw.selfCheckSdkDisallowed();
  for (const t of ['NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'TodoWrite', 'mcp__agent-hub__*']) assert.ok(dis.includes(t), `${t} disallowed`);
  for (const t of SIX) assert.ok(!dis.includes(t), `${t} stays`);
  // the hub's hands server (the boxed class): only the six exist
  const hubTools = L('hub-tools.js');
  const tools = hubTools.createHubTools({ cwd: ROOT });
  const stub = { tool: (name, description, shape, handler) => ({ name }), createSdkMcpServer: (cfg) => cfg };
  const server = sdkChat.__selfcheck.buildHandsMcpServer(stub, tools, { blocked: dis });
  assert.deepStrictEqual(server.tools.map(t => t.name).sort(), [...SIX].sort());
  // without the check agent's list every hands tool exists (the web ones too): this is what the list removes
  const all = sdkChat.__selfcheck.buildHandsMcpServer(stub, tools, { blocked: [] });
  assert.ok(all.tools.some(t => t.name === 'WebFetch'));
  // the Claude query options take the list only for a check agent (read by source: the options need a live client)
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(src, /twVirtual && twVirtual\.selfCheck === true\) for \(const t of temporalWorkers\.selfCheckSdkDisallowed\(\)\) if \(!blockedTools\.includes\(t\)\) blockedTools\.push\(t\)/);
  assert.match(src, /queryOptions\.disallowedTools = \[\.\.\.new Set\(\[\.\.\.\(queryOptions\.disallowedTools \|\| \[\]\), \.\.\.blockedTools\]\)\]/);
  assert.match(src, /buildHandsMcpServer\(sdk, hands\.tools, \{ blocked: blockedTools/);
  // ...and the client's built-in set itself is exactly the six (ToolSearch alone on hub hands), so a preset tool the
  // disallow list doesn't name can't reach a check agent
  assert.match(src, /twVirtual && twVirtual\.selfCheck === true\) queryOptions\.tools = hubHands \? \['ToolSearch'\] : \[\.\.\.temporalWorkers\.SELFCHECK_TOOLS\]/);
  assert.deepStrictEqual([...tw.SELFCHECK_TOOLS].sort(), [...SIX].sort());
});

test('gate: a check agent may call only the six tools (built-in or hub hands) and ToolSearch, even with the policy switched off', async () => {
  for (const enabled of [() => true, () => false]) {
    const s = stubGate({ enabled });
    for (const t of ['mcp__agent-hub__consult_agent', 'mcp__agent-hub__write_memory', 'WebFetch', 'Task', 'NotebookEdit', 'SomeFutureTool']) {
      const r = await s.gate.check({ agentName: 'selfcheck-lead', tool: t, input: {}, cwd: ROOT });
      assert.strictEqual(r.allowed, false, `${t} refused (policy ${enabled() ? 'on' : 'off'})`);
      assert.strictEqual(r.decision.reason, 'a self-check agent has only Read, Write, Edit, Glob, Grep and Bash');
    }
    for (const t of ['Read', 'mcp__hub__Read', 'ToolSearch']) {
      const r = await s.gate.check({ agentName: 'selfcheck-lead', tool: t, input: { file_path: path.join(ROOT, 'package.json') }, cwd: ROOT });
      assert.strictEqual(r.allowed, true, `${t} allowed (policy ${enabled() ? 'on' : 'off'})`);
    }
    // a real agent is untouched
    assert.strictEqual((await s.gate.check({ agentName: 'real-lead', tool: 'WebFetch', input: { url: 'https://example.com' }, cwd: ROOT })).allowed, true);
  }
});

test('gate: the observer hears the outcome, not the rule: an approved card is allow, a refused or timed-out one deny', async () => {
  for (const [answer, want] of [[{ decision: 'allow', by: 'owner' }, 'allow'], [{ decision: 'deny', by: 'owner' }, 'deny'], [{ decision: 'deny', by: 'timeout' }, 'deny']]) {
    const s = stubGate({ approvals: { request: () => ({ id: 'a1', promise: Promise.resolve(answer) }), timeoutMs: 1000 } });
    const r = await s.gate.check({ agentName: 'real-lead', tool: 'Write', input: { file_path: '/opt/zz-selfcheck-outside.txt' }, cwd: ROOT });
    assert.strictEqual(r.allowed, want === 'allow');
    assert.strictEqual(s.decisions.at(-1).decision, want, `card answered ${answer.decision} by ${answer.by}`);
  }
});

test('tools: on the gateway loop a check agent keeps only the six hands, whatever else is offered', () => {
  cleanup();
  const names = [...SIX, 'WebFetch', 'WebSearch', 'consult_agent', 'spawn_workers', 'write_memory', 'run_job', 'comms_send', 'create_agent', 'wallet_send', 'auth_http_request'];
  const mk = () => ({ list: names.map(n => ({ type: 'function', function: { name: n } })), handlers: new Map(names.map(n => [n, () => 'x'])) });
  const only = sdkChat.__selfcheck.selfCheckOnlyTools;
  mkVirtual('host');
  try {
    const a = mk();
    const out = only('selfcheck-host', a.list, a.handlers);
    assert.deepStrictEqual(out.map(t => t.function.name).sort(), [...SIX].sort());
    assert.deepStrictEqual([...a.handlers.keys()].sort(), [...SIX].sort(), 'handlers are pruned too');
    assert.deepStrictEqual(tw.selfCheckGatewayOnly().sort(), [...SIX].sort());
  } finally { cleanup(); }
  const b = mk();
  assert.strictEqual(only('some_real_agent', b.list, b.handlers).length, names.length, 'a real agent is untouched');
  assert.strictEqual(b.handlers.size, names.length);
});

// ── 8. Observing results ──────────────────────────────────────────────────────
test('observers: the Claude hooks pass results to the check agent\'s observer and always return {}', async () => {
  cleanup();
  const events = [];
  mkVirtual('host', (e) => events.push(e));
  try {
    const hooks = sdkChat.__selfcheck.selfCheckResultHooks('selfcheck-host');
    assert.deepStrictEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PostToolUseFailure']);
    const post = hooks.PostToolUse[0].hooks[0], fail = hooks.PostToolUseFailure[0].hooks[0];
    assert.deepStrictEqual(await post({ hook_event_name: 'PostToolUse', tool_name: 'mcp__hub__Write', tool_input: { file_path: '/x' }, tool_response: { type: 'create', filePath: '/x' } }), {});
    assert.deepStrictEqual(await post({ tool_name: 'Read', tool_input: { file_path: '/y' }, tool_response: 'x'.repeat(5000) }), {});
    assert.deepStrictEqual(await fail({ hook_event_name: 'PostToolUseFailure', tool_name: 'Edit', tool_input: { file_path: '/z' }, error: 'File has not been read yet' }), {});
    assert.deepStrictEqual(await post(undefined), {}, 'a bad input is ignored');
    assert.strictEqual(events[0].type, 'result');
    assert.strictEqual(events[0].tool, 'Write', 'mcp__hub__ is stripped');
    assert.strictEqual(events[0].ok, true);
    assert.deepStrictEqual(events[0].input, { file_path: '/x' });
    assert.match(events[0].text, /"filePath":"\/x"/);
    assert.strictEqual(events[1].text.length, 4096, 'cut to 4096');
    assert.deepStrictEqual([events[2].tool, events[2].ok, events[2].text], ['Edit', false, 'File has not been read yet']);
  } finally { cleanup(); }
  // an observer that throws changes nothing; a hook for an ordinary agent observes nothing
  mkVirtual('host', () => { throw new Error('boom'); });
  try { assert.deepStrictEqual(await sdkChat.__selfcheck.selfCheckResultHooks('selfcheck-host').PostToolUse[0].hooks[0]({ tool_name: 'Read', tool_input: {}, tool_response: 'a' }), {}); }
  finally { cleanup(); }
  assert.doesNotThrow(() => sdkChat.__selfcheck.observeResult('no_such_agent', 'Read', {}, true, 'a'));
  // the hooks are added to the query options for a check agent only (read by source)
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(src, /\.\.\.\(temporalWorkers\.isVirtual\(agentName\) && temporalWorkers\.isSelfCheck\(agentName\) \? selfCheckResultHooks\(agentName\) : \{\}\)/);
  assert.match(src, /observeResult\(agentName, toolName, observedArgs, handlerOk, result\)/, 'the gateway loop reports each handler result');
});

test('observers: a hub-hands call that failed is reported as failed, on the gateway loop and through MCP; the client\'s own results are not', async () => {
  cleanup();
  const events = [];
  mkVirtual('boxed', (e) => events.push(e));
  try {
    const obs = sdkChat.__selfcheck.observeResult;
    obs('selfcheck-boxed', 'Write', { file_path: '/x' }, true, 'Error: Writing outside the working folder was refused.');   // gateway: the hands' string
    obs('selfcheck-boxed', 'Write', { file_path: '/x' }, true, 'Wrote 12 bytes to /x');
    const post = sdkChat.__selfcheck.selfCheckResultHooks('selfcheck-boxed').PostToolUse[0].hooks[0];
    await post({ tool_name: 'mcp__hub__Write', tool_input: { file_path: '/y' }, tool_response: [{ type: 'text', text: 'Error: EACCES: permission denied' }] });   // MCP, as an array
    await post({ tool_name: 'mcp__hub__Read', tool_input: { file_path: '/y' }, tool_response: { content: [{ type: 'text', text: 'Error: not found' }] } });   // MCP, as an object
    await post({ tool_name: 'Read', tool_input: { file_path: '/z' }, tool_response: { type: 'text', file: { content: 'Error: this line is just the file\'s text' } } });   // the client's own Read
    assert.deepStrictEqual(events.map(e => [e.tool, e.ok]), [['Write', false], ['Write', true], ['Write', false], ['Read', false], ['Read', true]]);
  } finally { cleanup(); }
});

// ── 9. runSelfCheckTurn ───────────────────────────────────────────────────────
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
function walk(dir, out = []) { try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } } catch { /* none */ } return out; }
const leftovers = (name) => walk(ISO.data).filter(f => { try { return f.includes(name) || (fs.statSync(f).size < 5e6 && fs.readFileSync(f).includes(name)); } catch { return false; } });

test('runSelfCheckTurn: a real ephemeral turn through the chat route: reply, observer events, and no trace left anywhere', async () => {
  cleanup();
  const { sendSSE, makeChunk, setTestStreamer, turnRegistry } = sdkChat.__turn;
  const hubEvents = L('hub-events.js');
  const published = [];
  const off = hubEvents.events.onPublish(ev => { if (ev.agent === 'selfcheck-lead') published.push(ev); });
  const seen = {};
  const events = [];
  setTestStreamer(async ({ agent, res, message }) => {
    seen.agent = agent; seen.message = message;
    seen.virtual = tw.getVirtual(agent);
    seen.registered = turnRegistry.has(agent);
    const gate = sdkChat.__selfcheck.gate;
    await gate.check({ agentName: agent, tool: 'Read', input: { file_path: path.join(HOME, 'selfcheck', 'lead', 'read.txt') }, cwd: ROOT });
    sdkChat.__selfcheck.observeResult(agent, 'Read', { file_path: 'a' }, true, 'nonce');
    sendSSE(res, makeChunk('1. read ok\n2. code 1234', 'm'));
    res.write('data: [DONE]\n\n'); res.end();
  });
  const r = await sdkChat.runSelfCheckTurn({ name: 'selfcheck-lead', record: RECORDS.lead, model: 'claude-sdk/claude-haiku-5-5', prompt: 'Step 1: read the file.', observe: (e) => events.push(e), timeoutMs: 20000 });
  off();
  assert.deepStrictEqual(r, { reply: '1. read ok\n2. code 1234', error: null, errorKind: null });
  assert.strictEqual(seen.agent, 'selfcheck-lead');
  assert.match(seen.message, /Step 1: read the file\./);
  assert.ok(seen.virtual && seen.virtual.selfCheck === true, 'a check agent existed during the turn');
  assert.strictEqual(seen.virtual.model, 'claude-sdk/claude-haiku-5-5');
  assert.strictEqual(seen.virtual.record.lead, true);
  assert.strictEqual(seen.registered, false, 'no turnRegistry entry');
  assert.deepStrictEqual(events.map(e => [e.type, e.tool]), [['decision', 'Read'], ['result', 'Read']]);
  assert.strictEqual(tw.isVirtual('selfcheck-lead'), false, 'released afterwards');
  assert.deepStrictEqual(published, [], 'no hub event (no turn_start)');
  assert.strictEqual(turnRegistry.has('selfcheck-lead'), false);
  assert.deepStrictEqual(leftovers('selfcheck-lead'), [], 'nothing under data/ names the check agent: no log, session, transcript, memory or baseline');
  for (const f of ['agent-sessions.json', 'codex-sessions.json']) { const p = path.join(ISO.data, f); assert.ok(!fs.existsSync(p) || !fs.readFileSync(p, 'utf8').includes('selfcheck-'), f); }
  assert.ok(!fs.existsSync(path.join(ISO.data, 'conversations', 'selfcheck-lead.jsonl')));
  setTestStreamer(null);
});

test('runSelfCheckTurn: never throws; a bad name, a duplicate, a halted hub and a model failure each come back as a typed error', async () => {
  cleanup();
  const { sendSSE, makeChunk, setTestStreamer } = sdkChat.__turn;
  const call = (over = {}) => sdkChat.runSelfCheckTurn({ name: 'selfcheck-host', record: RECORDS.host, model: 'claude-sdk/claude-haiku-5-5', prompt: 'p', observe: () => {}, timeoutMs: 20000, ...over });
  // bad name: the check agent cannot be made
  const bad = await call({ name: 'tw-nope' });
  assert.strictEqual(bad.reply, ''); assert.strictEqual(bad.errorKind, 'unavailable'); assert.ok(bad.error);
  const none = await sdkChat.runSelfCheckTurn();
  assert.strictEqual(none.errorKind, 'unavailable', 'no arguments at all: still no throw');
  // duplicate: a second turn on a name already running
  mkVirtual('host');
  try { const dup = await call(); assert.strictEqual(dup.errorKind, 'unavailable'); assert.match(dup.error, /already running/); assert.ok(tw.isSelfCheck('selfcheck-host'), 'the running one is left alone'); }
  finally { cleanup(); }
  // halted: no turn starts
  let started = 0;
  setTestStreamer(async ({ res }) => { started++; res.end(); });
  hubHalt.getHubHalt().halt('test halt');
  try {
    const h = await call();
    assert.strictEqual(h.errorKind, 'halted'); assert.strictEqual(h.reply, ''); assert.match(h.error, /halt/i);
    assert.strictEqual(started, 0); assert.strictEqual(tw.isVirtual('selfcheck-host'), false);
  } finally { hubHalt.getHubHalt().resume(); }
  // a model failure the turn reports (plan limit, auth, network...)
  setTestStreamer(async ({ res }) => { sendSSE(res, makeChunk('', 'm', { type: 'turn_error', kind: 'rate_limit', message: 'You have hit your plan limit', help: 'Wait for the window to reset.' })); res.write('data: [DONE]\n\n'); res.end(); });
  const m = await call();
  assert.strictEqual(m.errorKind, 'model'); assert.strictEqual(m.reply, ''); assert.match(m.error, /Wait for the window to reset|plan limit/);
  // an empty reply is "no answer", not a pass
  setTestStreamer(async ({ res }) => { res.write('data: [DONE]\n\n'); res.end(); });
  const e = await call();
  assert.strictEqual(e.errorKind, 'unavailable'); assert.strictEqual(e.reply, '');
  assert.strictEqual(tw.isVirtual('selfcheck-host'), false, 'always released');
  setTestStreamer(null);
});

test('runSelfCheckTurn: a turn that runs too long is stopped and reported as a timeout; an outer stop is reported as stopped', async () => {
  cleanup();
  const { setTestStreamer } = sdkChat.__turn;
  let ended = false;
  setTestStreamer(async ({ res, signal }) => { await new Promise(r => { if (signal.aborted) r(); else signal.addEventListener('abort', r, { once: true }); }); ended = true; try { res.end(); } catch {} });
  const t0 = Date.now();
  const r = await sdkChat.runSelfCheckTurn({ name: 'selfcheck-boxed', record: RECORDS.boxed, model: 'claude-sdk/claude-haiku-5-5', prompt: 'p', observe: () => {}, timeoutMs: 1200 });
  assert.strictEqual(r.errorKind, 'timeout'); assert.strictEqual(r.reply, ''); assert.match(r.error, /longer than/);
  assert.ok(Date.now() - t0 < 8000, 'returned soon after the limit');
  assert.ok(ended, 'the running turn was stopped, not left behind');
  assert.strictEqual(tw.isVirtual('selfcheck-boxed'), false);
  // the caller's own signal
  const ac = new AbortController();
  ended = false;
  const p = sdkChat.runSelfCheckTurn({ name: 'selfcheck-shared', record: RECORDS.shared, model: 'claude-sdk/claude-haiku-5-5', prompt: 'p', observe: () => {}, signal: ac.signal, timeoutMs: 60000 });
  await tick(300); ac.abort();
  const s = await p;
  assert.strictEqual(s.errorKind, 'unavailable'); assert.match(s.error, /stopped/);
  assert.ok(ended); assert.strictEqual(tw.isVirtual('selfcheck-shared'), false);
  const pre = new AbortController(); pre.abort();
  assert.strictEqual((await sdkChat.runSelfCheckTurn({ name: 'selfcheck-lead', record: RECORDS.lead, model: 'm', prompt: 'p', signal: pre.signal })).errorKind, 'unavailable');
  setTestStreamer(null);
});

// ── 10. Routes and readiness ──────────────────────────────────────────────────
function fakeSelfCheck(over = {}) {
  const calls = { run: [], saved: [] };
  let stored = { enabled: true, afterStart: true, nightlyAt: '03:45', classes: ['lead', 'host', 'boxed', 'shared'], model: 'auto' };
  let running = false;
  const sc = {
    view: () => ({ settings: stored, running, lastRun: null, failingSince: {}, history: [], readiness: [] }),
    isRunning: () => running, settings: () => stored,
    run: async (o) => { calls.run.push(o); },
    ...over,
  };
  return { sc, calls, setRunning: (b) => { running = b; }, get stored() { return stored; }, save: (v) => { stored = v; calls.saved.push(v); } };
}
const validate = (o) => {
  const known = ['enabled', 'afterStart', 'nightlyAt', 'classes', 'model'];
  for (const k of Object.keys(o)) if (!known.includes(k)) return { ok: false, error: `unknown setting "${k}"` };
  if (typeof o.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
  return { ok: true, value: { ...o } };
};
const routes = L('selfcheck-routes.js');
const call = (f, method, pathname, { admin = true, body = {} } = {}) => routes.handle({ method, pathname, admin, body, selfCheck: () => f.sc, validateSettings: validate, saveSettings: f.save, log: () => {} });

test('routes: a member gets 403 on all three, and so does anything that is not an admin', async () => {
  const f = fakeSelfCheck();
  for (const [m, p] of [['GET', '/api/selfcheck'], ['POST', '/api/selfcheck/run'], ['PUT', '/api/selfcheck/settings']]) {
    for (const admin of [false, null, 'yes', 1]) {
      const r = await call(f, m, p, { admin });
      assert.deepStrictEqual(r, { status: 403, body: { error: 'admin_only' } }, `${m} ${p} admin=${String(admin)}`);
    }
  }
  assert.deepStrictEqual(f.calls.run, []); assert.deepStrictEqual(f.calls.saved, []);
  // the route table also keeps every member out of these paths, and tokens too
  for (const p of ['/api/selfcheck', '/api/selfcheck/run', '/api/selfcheck/settings']) assert.deepStrictEqual(access.classifyRoute(p, 'GET'), { kind: 'admin' }, p);
  assert.strictEqual(await call(f, 'GET', '/api/other'), null);
  assert.strictEqual(await call(f, 'DELETE', '/api/selfcheck'), null);
});

test('routes: GET answers the view; POST /run answers 202 and starts it in the background, or 409 when running or disabled', async () => {
  const f = fakeSelfCheck();
  const g = await call(f, 'GET', '/api/selfcheck');
  assert.strictEqual(g.status, 200); assert.deepStrictEqual(Object.keys(g.body).sort(), ['failingSince', 'history', 'lastRun', 'readiness', 'running', 'settings']);
  const r = await call(f, 'POST', '/api/selfcheck/run');
  assert.deepStrictEqual(r, { status: 202, body: { started: true } });
  await tick(5);
  assert.deepStrictEqual(f.calls.run, [{ trigger: 'manual' }]);
  f.setRunning(true);
  assert.deepStrictEqual(await call(f, 'POST', '/api/selfcheck/run'), { status: 409, body: { error: 'running' } });
  f.setRunning(false);
  f.save({ ...f.stored, enabled: false });
  assert.deepStrictEqual(await call(f, 'POST', '/api/selfcheck/run'), { status: 409, body: { error: 'disabled' } });
  assert.strictEqual(f.calls.run.length, 1, 'neither refusal started a run');
  // a run that fails is logged, never an unhandled rejection
  const logs = []; const bad = fakeSelfCheck({ run: async () => { throw new Error('nope'); } });
  const rr = await routes.handle({ method: 'POST', pathname: '/api/selfcheck/run', admin: true, selfCheck: () => bad.sc, validateSettings: validate, saveSettings: () => {}, log: (m) => logs.push(m) });
  assert.strictEqual(rr.status, 202); await tick(10);
  assert.ok(logs.some(l => /manual run failed: nope/.test(l)));
});

test('routes: PUT /settings merges a partial object, saves what validates and refuses the rest with a 400', async () => {
  const f = fakeSelfCheck();
  const ok = await call(f, 'PUT', '/api/selfcheck/settings', { body: { afterStart: false } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.settings.afterStart, false);
  assert.strictEqual(ok.body.settings.nightlyAt, '03:45', 'the rest is kept');
  assert.strictEqual(f.calls.saved.length, 1);
  const unknown = await call(f, 'PUT', '/api/selfcheck/settings', { body: { sneaky: 1 } });
  assert.strictEqual(unknown.status, 400); assert.match(unknown.body.error, /unknown setting/);
  const notObj = await call(f, 'PUT', '/api/selfcheck/settings', { body: null });
  assert.deepStrictEqual(notObj, { status: 400, body: { error: 'invalid JSON' } });
  assert.strictEqual((await call(f, 'PUT', '/api/selfcheck/settings', { body: [] })).status, 400);
  const badVal = await call(f, 'PUT', '/api/selfcheck/settings', { body: { enabled: 'yes' } });
  assert.strictEqual(badVal.status, 400);
  assert.strictEqual(f.calls.saved.length, 1, 'only the good one was saved');
  // a self-check that throws answers 500, not a crash
  const boom = await routes.handle({ method: 'GET', pathname: '/api/selfcheck', admin: true, selfCheck: () => { throw new Error('x'); }, validateSettings: validate, saveSettings: () => {}, log: () => {} });
  assert.strictEqual(boom.status, 500);
});

test('server.js: the routes go through the handler with an admin test, and the start hook is guarded and lazy', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /require\('\.\/lib\/selfcheck-routes'\)\.handle\(\{/);
  assert.match(src, /admin: !!req\.hubService \|\| \(access\.isAdmin\(req\.hubUser\) && !req\.hubPendingTotp\)/);
  assert.match(src, /saveSettings: \(v\) => hubSettings\.updateSettings\(\{ selfCheck: v \}\)/);
  assert.match(src, /if \(process\.env\.HUB_SELFCHECK !== 'off'\) \{ const sc = require\('\.\/lib\/selfcheck'\)\.getSelfCheck\(\); sc\.onStarted\(\); sc\.schedule\(\); \}/);
  assert.ok(!/^const .*require\('\.\/lib\/selfcheck'\)/m.test(src), 'lib/selfcheck is required lazily, never at the top');
});

test('readiness: self-check items join the Status list; a missing or failing module adds nothing', async () => {
  const { createReadiness } = L('readiness.js');
  const base = { hasUsers: () => true, listUsers: () => [], legacyAuth: () => false, agents: async () => [], getSetting: () => undefined };
  const item = { id: 'selfcheck', level: 'warn', title: 'Self-check: ordinary agents can\'t write files', detail: 'd', fix: 'f' };
  const withItem = await createReadiness({ ...base, selfCheckItems: () => [item] }).check();
  assert.ok(withItem.items.some(i => i.id === 'selfcheck' && i.level === 'warn'), 'the item is listed');
  const throwing = await createReadiness({ ...base, selfCheckItems: () => { throw new Error('module missing'); } }).check();
  assert.ok(!throwing.items.some(i => i.id === 'selfcheck'));
  const rejecting = await createReadiness({ ...base, selfCheckItems: async () => { throw new Error('x'); } }).check();
  assert.ok(!rejecting.items.some(i => i.id === 'selfcheck'));
  const none = await createReadiness({ ...base }).check();
  assert.ok(!none.items.some(i => i.id === 'selfcheck'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'readiness.js'), 'utf8');
  assert.match(src, /selfCheckItems: \(\) => \{ try \{ return require\('\.\/selfcheck'\)\.getSelfCheck\(\)\.readinessItems\(\); \} catch \{ return \[\]; \} \}/);
});
