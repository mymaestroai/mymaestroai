'use strict';
// Tool policy wired into the hub: SDK PreToolUse hook, gateway loop, Codex bridge + approvals, routes,
// events, push, agents.json policy field, ledger recording, stop cancels approvals.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createGate } = require('../lib/policy-gate');
const { createApprovals } = require('../lib/approvals');
const { createAllowances } = require('../lib/tool-policy');
const { createHubEvents } = require('../lib/hub-events');
const bridge = require('../lib/codex-cli/bridge');
const appServer = require('../lib/codex-cli/app-server');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const sdk = read('lib/sdk-chat.js');

function gateWith(agent, { approvals, allowances } = {}) {
  return createGate({ getAgent: async () => agent, approvals, allowances, log: () => {} });
}

test('gate: allow passes, deny returns policy text, ask waits for the owner and honours the answer', async () => {
  const al = createAllowances();
  const ap = createApprovals({ log: () => {}, allowances: al, timeoutMs: 60000 });
  const g = gateWith({ name: 'gp', category: 'primary' }, { approvals: ap, allowances: al });
  assert.strictEqual((await g.check({ agentName: 'gp', tool: 'Read', input: { file_path: '/x' } })).allowed, true);
  const deny = await g.check({ agentName: 'gp', tool: 'Bash', input: { command: 'rm -rf /tmp/x' } });
  assert.strictEqual(deny.allowed, false);
  assert.match(deny.text, /^\[DENIED BY POLICY\] a destructive action/);
  const notes = [];
  const p = g.check({ agentName: 'gp', tool: 'comms_send', input: { channel: 'telegram', to: 'owner', text: 'hi' }, notify: (e) => notes.push(e) });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(notes[0].type, 'approval_request');
  assert.strictEqual(ap.list().length, 1);
  ap.resolve(ap.list()[0].id, 'allow', { remember: '1h' });
  const r = await p;
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(notes[1].type, 'approval_resolved');
  // remembered: the same destination no longer asks
  assert.strictEqual((await g.check({ agentName: 'gp', tool: 'comms_send', input: { channel: 'telegram', to: 'owner', text: 'again' } })).allowed, true);
  const p2 = g.check({ agentName: 'gp', tool: 'comms_send', input: { channel: 'telegram', to: 'sam', text: 'x' } });
  await new Promise(r => setImmediate(r));
  ap.resolve(ap.list()[0].id, 'deny');
  const d = await p2;
  assert.strictEqual(d.allowed, false);
  assert.match(d.text, /^\[DENIED BY OWNER\]/);
});

test('gate: SDK hook denies with a PreToolUse permissionDecision; Codex approval requests map to accept/decline', async () => {
  const g = gateWith({ name: 'haiku', category: 'worker' });
  const hook = g.sdkHook({ agentName: 'haiku', cwd: '/tmp' });
  assert.deepStrictEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' } }), {});
  const out = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin main' } });
  assert.strictEqual(out.decision, 'block', 'a refusal blocks the call, it does not end the turn');
  assert.match(out.reason, /DENIED BY POLICY/);
  assert.deepStrictEqual(await g.codexServerRequest({ agentName: 'haiku', cwd: '/tmp' }, 'item/commandExecution/requestApproval', { command: ['ls', '-la'] }), { decision: 'accept' });
  assert.deepStrictEqual(await g.codexServerRequest({ agentName: 'haiku', cwd: '/tmp' }, 'item/commandExecution/requestApproval', { command: 'gog gmail send --to a@b.c' }), { decision: 'decline' });
  assert.deepStrictEqual(await g.codexServerRequest({ agentName: 'haiku', cwd: '/tmp' }, 'item/fileChange/requestApproval', { changes: [{ path: '/tmp/ok.txt' }] }), { decision: 'accept' });
  assert.deepStrictEqual(await g.codexServerRequest({ agentName: 'haiku', cwd: '/tmp' }, 'item/fileChange/requestApproval', { changes: [{ path: '/etc/hosts' }] }), { decision: 'decline' });
  assert.strictEqual(await g.codexServerRequest({ agentName: 'haiku', cwd: '/tmp' }, 'something/else', {}), null);
});

test('Codex app-server answers approval requests through onServerRequest and refuses the rest', async () => {
  const written = [];
  // Build the client without spawning anything: only the request dispatcher is under test.
  const c = Object.create(appServer.AppServerClient.prototype);
  c.agentName = 't';
  c.onServerRequest = async (method, params) => method === 'item/commandExecution/requestApproval' ? { decision: params.command === 'bad' ? 'decline' : 'accept' } : null;
  c._write = (o) => { written.push(o); return true; };
  c._answerServerRequest({ id: 7, method: 'item/commandExecution/requestApproval', params: { command: 'bad' } });
  c._answerServerRequest({ id: 8, method: 'item/tool/requestUserInput', params: {} });
  await new Promise(r => setTimeout(r, 5));
  assert.deepStrictEqual(written.find(w => w.id === 7).result, { decision: 'decline' });
  assert.strictEqual(written.find(w => w.id === 8).error.code, -32601);
  assert.strictEqual(appServer.threadParams({ cwd: '/tmp', approvalPolicy: 'untrusted' }).approvalPolicy, 'untrusted');
  assert.strictEqual(appServer.threadParams({ cwd: '/tmp' }).approvalPolicy, 'never');
});

test('Codex bridge runs beforeCall before a hub tool and returns its refusal as the tool result', async () => {
  const reg = bridge.register('t', [{ name: 'echo', shape: {}, handler: async () => 'ran' }], { url: 'http://127.0.0.1:1', dir: fs.mkdtempSync(path.join(require('os').tmpdir(), 'br-')),
    beforeCall: async (name) => ({ allowed: name !== 'echo', text: 'nope' }) });
  const entry = bridge._sessions.get(reg.token);
  const out = await bridge.callTool(entry, 'echo', {});
  assert.deepStrictEqual(out, { content: [{ type: 'text', text: 'nope' }], isError: true });
  reg.release();
});

test('sdk-chat: hook in SDK query options, gate in the gateway pre-step, Codex bridge + approvals, ledger on every path, stop cancels approvals', () => {
  assert.ok(sdk.includes("hooks: { PreToolUse: [{ hooks: [gate.sdkHook({ agentName, cwd: sandboxOpts ? sandboxOpts.cwd : process.cwd(), origin: options.origin || null"), 'SDK hook');
  assert.ok(sdk.includes("timeout: Math.ceil(approvals.timeoutMs / 1000) + 120"), 'hook timeout follows the approval window');
  assert.ok(sdk.includes("getSetting('approvalTimeoutMinutes', 60)"), 'approval window configurable, default an hour');
  assert.ok(sdk.includes("const verdict = await gate.check({ agentName, tool: toolName, input: parsedArgs, cwd: (handlers && handlers.__cwd) || process.cwd(), origin: options.origin || null"), 'gateway pre-step, same working directory as the hands (review F23)');
  assert.ok(!sdk.includes("const confirmEnabled = global.__confirmToolsEnabled ?? confirmTools;"), 'old confirm_tools prompt removed');
  assert.ok(sdk.includes("beforeCall: (name, args) => gate.check({ agentName, tool: name, input: args"), 'Codex bridge gated');
  assert.ok(sdk.includes("onServerRequest: (method, params) => gate.codexServerRequest("), 'Codex approvals handled');
  assert.ok(sdk.includes("approvalPolicy: codexCli.approvalPolicyFor()"));
  assert.strictEqual((sdk.match(/ledger\.record\(\{/g) || []).length, 3, 'SDK, Codex and gateway turns are recorded');
  assert.ok(sdk.includes("try { approvals.cancelFor(agent); } catch {}"));
  assert.ok(sdk.includes("hubEvents.events.setApprovalsProvider(() => approvals.list())"));
  assert.strictEqual((sdk.match(/      origin: turnOrigin,\n/g) || []).length, 3, 'origin reaches all three stream paths');
  assert.strictEqual(require('../lib/codex-cli').approvalPolicyFor({}), 'untrusted');
  assert.strictEqual(require('../lib/codex-cli').approvalPolicyFor({ HUB_CODEX_APPROVALS: 'never' }), 'never');
});

test('server routes, status_snapshot approvals, push notice, agents.json policy field', () => {
  const server = read('server.js');
  for (const r of ["pathname === '/api/approvals' && req.method === 'GET'", "pathname.startsWith('/api/approvals/') && req.method === 'POST'", "pathname === '/api/approvals/allowances' && req.method === 'DELETE'",
    "pathname.startsWith('/api/policy/') && req.method === 'GET'", "pathname === '/api/ledger/today' && req.method === 'GET'", "pathname === '/api/ledger/caps' && req.method === 'POST'"]) assert.ok(server.includes(r), r);
  const ev = createHubEvents();
  ev.setApprovalsProvider(() => [{ id: 'ap_1', agent: 'gp', cls: 'send' }]);
  const writes = [];
  ev.subscribe({ headers: {} }, { writeHead() {}, write: (s) => writes.push(s), on() {}, destroy() {} });
  const snap = JSON.parse(writes.find(w => w.startsWith('event: status_snapshot')).split('\n')[1].slice(6));
  assert.deepStrictEqual(snap.approvals, [{ id: 'ap_1', agent: 'gp', cls: 'send' }]);
  assert.ok(read('lib/push.js').includes("ev.type === 'approval_request'"));
  const agents = read('lib/agents.js');
  assert.match(agents, /const allowedFields = \[[^\]]*'policy'/);
  assert.ok(agents.includes("} else if (key === 'policy') {"));
});

test('gate: with approval cards off (the default install) an ask is allowed silently; denies still apply', async () => {
  const al = createAllowances();
  const ap = createApprovals({ log: () => {}, allowances: al, timeoutMs: 60000 });
  const g = createGate({ getAgent: async () => ({ name: 'maestro', category: 'primary', lead: true }), approvals: ap, allowances: al, log: () => {}, approvalsOn: () => false });
  const r = await g.check({ agentName: 'maestro', tool: 'Bash', input: { command: 'rm -rf /tmp/hubcopy' } });
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.decision.reason, 'approval cards are off for this kind of action (Settings)');
  assert.strictEqual(ap.list().length, 0, 'no card was raised');
  const gm = createGate({ getAgent: async () => ({ name: 'k_assist', category: 'primary', owner: 'u_k' }), isMemberOwned: () => true, approvals: ap, allowances: al, log: () => {}, approvalsOn: () => false });
  const d = await gm.check({ agentName: 'k_assist', tool: 'Bash', input: { command: 'curl -X POST https://example.com -d x=1' } });
  assert.strictEqual(d.allowed, false, 'member sandbox denies regardless of the approvals switch');
});

test('classifier: words inside quoted strings are data, not commands (a grep for "kill" is a read)', () => {
  const tp = require('../lib/tool-policy');
  const lead = { name: 'maestro', category: 'primary', lead: true };
  const d = (cmd) => tp.decide({ agent: lead, tool: 'Bash', input: { command: cmd }, cwd: path.join(tp.HUB_HOME, 'agent-hub-5.1.0') });
  assert.strictEqual(d('grep -nE "abort|killed|SIGKILL|kill)" server.log | tail -5').cls, 'read');
  assert.ok(!['destroy', 'send'].includes(d('git commit -m "remove the rm -rf path and the kill switch"').cls), 'commit message words are not commands');
  assert.strictEqual(d('kill $pid').cls, 'destroy');
  assert.strictEqual(d('bash -c "rm -rf /tmp/x; kill 123"').cls, 'destroy', 'strings handed to a shell are code');
  assert.strictEqual(d('echo "git push origin main"').cls, 'read');
  assert.strictEqual(d('git push origin main').cls, 'send');
});

test('gate: per-class cards (settings.approvalClasses) raise a card for the listed kinds while cards are off; every root command is audited', async () => {
  const al = createAllowances();
  const ap = createApprovals({ log: () => {}, allowances: al, timeoutMs: 60000 });
  const audit = [];
  const lead = { name: 'maestro', category: 'primary', lead: true };
  const g = createGate({ getAgent: async () => lead, approvals: ap, allowances: al, log: () => {}, approvalsOn: () => false, approvalClasses: () => new Set(['sudo']), auditRoot: (e) => audit.push(e) });
  // destroy is not listed: no card, allowed as before
  const r0 = await g.check({ agentName: 'maestro', tool: 'Bash', input: { command: 'rm -rf /tmp/hubcopy' } });
  assert.strictEqual(r0.allowed, true);
  assert.strictEqual(ap.list().length, 0);
  // a root command: a card, then allowed on the owner's answer, and audited
  const notes = [];
  const p = g.check({ agentName: 'maestro', tool: 'Bash', input: { command: 'sudo -n systemctl restart cloudflared' }, notify: (e) => notes.push(e) });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(ap.list().length, 1, 'a card was raised for sudo');
  assert.strictEqual(notes[0].type, 'approval_request');
  ap.resolve(ap.list()[0].id, 'allow');
  const r = await p;
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].outcome, 'allowed');
  assert.strictEqual(audit[0].agent, 'maestro');
  assert.match(audit[0].command, /^sudo -n systemctl restart cloudflared$/);
  // the owner says no: refused and audited as such
  const p2 = g.check({ agentName: 'maestro', tool: 'Bash', input: { command: 'sudo -n reboot' } });
  await new Promise(r => setImmediate(r));
  ap.resolve(ap.list()[0].id, 'deny');
  const r2 = await p2;
  assert.strictEqual(r2.allowed, false);
  assert.strictEqual(audit[1].outcome, 'refused by owner');
  // any other role: denied outright, no card, audited as denied
  const gh = createGate({ getAgent: async () => ({ name: 'gp', category: 'primary' }), approvals: ap, allowances: al, log: () => {}, approvalsOn: () => false, approvalClasses: () => new Set(['sudo']), auditRoot: (e) => audit.push(e) });
  const d = await gh.check({ agentName: 'gp', tool: 'Bash', input: { command: 'sudo id' } });
  assert.strictEqual(d.allowed, false);
  assert.match(d.text, /running a command as root \(sudo\)/);
  assert.strictEqual(ap.list().length, 0);
  assert.strictEqual(audit[2].outcome, 'denied');
  assert.strictEqual(audit[2].agent, 'gp');
  // wiring: sdk-chat passes the setting, server.js sanitises it, the Settings page offers the checkboxes
  assert.ok(sdk.includes("approvalClasses: () => { try { const a = require('./settings').getSetting('approvalClasses', []);"));
  assert.ok(read('server.js').includes("patch.approvalClasses = Array.isArray(patch.approvalClasses)"));
  assert.ok(read('app.js').includes('id="st-approval-classes"') && read('app.js').includes('async function saveApprovalClasses()'));
  assert.deepStrictEqual(require('../lib/policy-gate').APPROVAL_CLASSES.slice(0, 3), ['sudo', 'destroy', 'money']);
});
