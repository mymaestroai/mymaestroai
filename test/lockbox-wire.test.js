'use strict';
// The command lockbox wired into the hub's Bash, run_job and the Claude client's Bash hook (lib/lockbox/wire.js and its
// callers). With every mode off each path must behave exactly as before; with enforce the boxes are real (Landlock),
// so those tests skip with a reason when the helper's probe says this computer cannot do it.
// Everything runs in temp folders; the install's own data/ is never opened.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const toolPolicy = require('../lib/tool-policy');
const lb = require('../lib/lockbox');
const { createWire } = require('../lib/lockbox/wire');
const { createHubTools } = require('../lib/hub-tools');
const { JobRunner } = require('../lib/jobs');
const { createGate } = require('../lib/policy-gate');
const { createApprovals } = require('../lib/approvals');

const tmp = (label = 'lockbox-wire-') => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), label));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(40); } return false; }

const host = lb.probe();
const NO_BOX = host.ok ? false : 'the lockbox helper cannot run here: ' + host.reason;
// The enforce tests build real boxes with no read holes (admin 'allow' in the box's rules): with holes the helper lists the
// siblings of the install's secret paths, and a clone in /tmp has tens of thousands of siblings (its limit is 20000 rules).
// What the holes hide is lockbox-run.test.js's job; here the point is that each path runs boxed.
const BOX_OK = 'allow';
const okProbe = () => ({ ok: true, reason: '' });
const badProbe = () => ({ ok: false, reason: 'no landlock' });

/** Temp hub home and install folder, a workspace for agent-a and a share folder (neither under the real install). */
function world() {
  const hubHome = tmp();
  const hubRoot = tmp();
  const ws = path.join(hubRoot, 'workspaces', 'agent-a');
  const share = path.join(hubHome, 'share');
  const outside = tmp('lockbox-outside-');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(share, { recursive: true });
  return { hubHome, hubRoot, ws, share, outside, workspaces: ['agent-a'] };
}

/** The role and rules of policyFor, with roots that do NOT include /tmp (the temp folders live there). */
function policyIn(w, rolesAdmin, extraRoots = []) {
  return (rec) => {
    const p = toolPolicy.policyFor(rec);
    return { ...p, rules: rolesAdmin ? { ...p.rules, admin: rolesAdmin } : p.rules, roots: [path.join(w.hubRoot, 'workspaces', rec.name), w.share, ...extraRoots] };
  };
}

function wireFor(w, { agents, virtual = () => null, setting = () => undefined, probe, rolesAdmin, extraRoots } = {}) {
  return createWire({
    getAgents: () => agents, getVirtual: virtual, getSetting: setting,
    policyFor: policyIn(w, rolesAdmin, extraRoots),
    decideExtra: { hubHome: w.hubHome, hubRoot: w.hubRoot, workspaces: w.workspaces, ...(probe ? { probe } : {}) },
  });
}

/** Run fn with child_process.spawn recording its calls (it still spawns). */
async function recordSpawns(fn) {
  const real = cp.spawn;
  const calls = [];
  cp.spawn = (...a) => { calls.push(a); return real(...a); };
  try { await fn(); } finally { cp.spawn = real; }
  return calls;
}

const AGENT_OFF = { name: 'agent-a', category: 'worker' };
const AGENT_ENFORCE = { name: 'agent-a', category: 'worker', lockbox: 'enforce' };

// ── off parity ───────────────────────────────────────────────────────

test('off parity, hub Bash: the same spawn arguments with or without lockboxFor', async () => {
  const w = world();
  const wire = wireFor(w, { agents: [AGENT_OFF] });
  const run = async (lockboxFor) => {
    let text;
    const calls = await recordSpawns(async () => { text = (await createHubTools({ cwd: w.ws, log: () => {}, lockboxFor }).call('Bash', { command: 'echo parity' })).text; });
    return { text, calls };
  };
  const plain = await run(null);
  const wired = await run((o) => wire.lockboxFor({ ...o, agentName: 'agent-a', sandboxed: false }));
  assert.strictEqual(plain.text, 'parity');
  assert.strictEqual(wired.text, 'parity');
  assert.strictEqual(plain.calls.length, 1);
  assert.deepStrictEqual(wired.calls, plain.calls, 'same file, args and options (cwd, env, detached, stdio)');
  assert.strictEqual(wired.calls[0][0], 'bash');
  assert.deepStrictEqual(wired.calls[0][1], ['-c', 'echo parity']);
});

test('off parity, run_job: wrapper.sh is the text today\'s code writes', async () => {
  const w = world();
  const wire = wireFor(w, { agents: [AGENT_OFF] });
  const texts = [];
  for (const lockboxFor of [null, (a) => wire.lockboxFor(a)]) {
    const dataDir = tmp('lockbox-jobs-');
    const runner = new JobRunner({ dataDir, spawnMode: 'setsid', log: () => {}, defaultCwd: async () => w.ws, lockboxFor });
    const j = await runner.run({ owner: 'agent-a', name: 'parity', command: 'echo hi', cwd: w.ws });
    const dir = path.join(dataDir, 'jobs', j.id);
    texts.push(fs.readFileSync(path.join(dir, 'wrapper.sh'), 'utf8').split(dir).join('<DIR>'));
    assert.strictEqual(j.lockbox, undefined, 'no lockbox field on the job record');
    runner.stop();
  }
  assert.strictEqual(texts[0], texts[1]);
  assert.ok(texts[0].includes('\nbash "$D/job.sh" > "$D/out.log" 2>&1\n'));
  assert.ok(!texts[0].includes('lockbox-run'));
});

test('off parity, sdkHook: {} for an allowed Bash call, with or without lockboxFor', async () => {
  const w = world();
  const wire = wireFor(w, { agents: [AGENT_OFF] });
  const hookInput = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } };
  const mk = (extra) => createGate({ getAgent: async () => AGENT_OFF, approvals: null, ...extra }).sdkHook({ agentName: 'agent-a', cwd: w.ws });
  assert.deepStrictEqual(await mk({})(hookInput), {});
  assert.deepStrictEqual(await mk({ lockboxFor: wire.lockboxFor })(hookInput), {});
  const sandboxedHook = createGate({ getAgent: async () => AGENT_ENFORCE, approvals: null, lockboxFor: () => { throw new Error('not asked'); } }).sdkHook({ agentName: 'agent-a', cwd: w.ws, sandboxed: true });
  assert.deepStrictEqual(await sandboxedHook(hookInput), {}, 'a client that runs in a container is not boxed again');
  const mcpHook = createGate({ getAgent: async () => AGENT_ENFORCE, approvals: null, lockboxFor: () => { throw new Error('not asked'); } }).sdkHook({ agentName: 'agent-a', cwd: w.ws });
  assert.deepStrictEqual(await mcpHook({ ...hookInput, tool_name: 'mcp__hub__Bash' }), {}, 'the hub\'s Bash is boxed by the hub tools, not here');
});

// ── the adapter ──────────────────────────────────────────────────────

test('wire: no record means off; the agent setting and the hub default decide the mode; a container is never boxed', () => {
  const w = world();
  const wire = wireFor(w, { agents: [AGENT_ENFORCE, { name: 'agent-b', category: 'worker' }], probe: okProbe });
  assert.deepStrictEqual(wire.lockboxFor({ agentName: 'nobody', tool: 'Bash', command: 'ls' }), { mode: 'off' });
  const d = wire.lockboxFor({ agentName: 'agent-a', tool: 'Bash', command: 'ls' });
  assert.strictEqual(d.mode, 'enforce');
  assert.ok(d.profile && d.profile.agent === 'agent-a');
  assert.deepStrictEqual(wire.lockboxFor({ agentName: 'agent-a', tool: 'Bash', command: 'ls', sandboxed: true }), { mode: 'off' });
  assert.deepStrictEqual(wire.lockboxFor({ agentName: 'agent-b', tool: 'Bash', command: 'ls' }), { mode: 'off' });
  const wire2 = wireFor(w, { agents: [{ name: 'agent-b', category: 'worker' }], setting: (k) => (k === 'lockboxDefault' ? 'watch' : undefined), probe: okProbe });
  assert.strictEqual(wire2.lockboxFor({ agentName: 'agent-b', tool: 'Bash', command: 'ls' }).mode, 'watch');
});

test('wire: a temporary worker takes its parent\'s mode and folder, and the rules of the record the gate uses', () => {
  const w = world();
  const seen = [];
  const wire = createWire({
    getAgents: () => [{ name: 'agent-a', category: 'worker', lockbox: 'enforce', owner: null }, { name: 'agent-c', category: 'worker', lockbox: 'off' }],
    getVirtual: (n) => (n === 'tw-1' ? { parent: 'agent-a' } : n === 'tw-2' ? { parent: 'agent-c' } : n === 'tw-3' ? { parent: 'gone' } : null),
    getSetting: (k) => (k === 'lockboxDefault' ? 'watch' : undefined),
    policyFor: (rec) => { seen.push(rec); return policyIn(w)(rec); },
    decideExtra: { hubHome: w.hubHome, hubRoot: w.hubRoot, workspaces: w.workspaces, probe: okProbe },
  });
  const d = wire.lockboxFor({ agentName: 'tw-1', tool: 'Bash', command: 'ls' });
  assert.strictEqual(d.mode, 'enforce', 'the parent\'s mode');
  assert.strictEqual(d.profile.agent, 'agent-a', 'the parent\'s folder');
  const dirs = lb.agentDirs('agent-a', { hubHome: w.hubHome });
  assert.ok(d.profile.writes.includes(dirs.dir), 'its box can write the parent\'s lockbox folder');
  assert.ok(fs.existsSync(dirs.tmp));
  assert.strictEqual(seen.length >= 1 && seen[0].name, 'tw-1', 'the rules come from the worker\'s own record');
  assert.strictEqual(seen[0].category, 'worker');
  assert.strictEqual(seen[0].virtualOf, 'agent-a');
  assert.ok(d.profile.writes.includes(path.join(w.hubRoot, 'workspaces', 'tw-1')) || !fs.existsSync(path.join(w.hubRoot, 'workspaces', 'tw-1')), 'roots of the worker record');
  assert.strictEqual(wire.lockboxFor({ agentName: 'tw-2', tool: 'Bash', command: 'ls' }).mode, 'off', 'a parent set to off');
  assert.deepStrictEqual(wire.lockboxFor({ agentName: 'tw-3', tool: 'Bash', command: 'ls' }), { mode: 'watch', plain: true }, 'a parent that is gone: the hub default (watch here) decides');
  assert.strictEqual(wire.folderNameFor('tw-1'), 'agent-a');
  assert.strictEqual(wire.folderNameFor('agent-c'), 'agent-c');
  assert.strictEqual(wire.approvalNameFor('tw-1'), 'agent-a');
  assert.strictEqual(wire.approvalNameFor('tw-2'), null, 'off: nothing to widen');
});

test('wire: the lead with a sudo command runs unconfined and the log says so', () => {
  const w = world();
  const wire = wireFor(w, { agents: [{ name: 'lead-a', category: 'primary', lead: true, lockbox: 'enforce' }], probe: badProbe });
  const d = wire.lockboxFor({ agentName: 'lead-a', tool: 'Bash', command: 'sudo ls /root' });
  assert.deepStrictEqual(d, { mode: 'enforce', unconfined: 'sudo' });
  const lines = lb.readLog({ agent: 'lead-a', hubRoot: w.hubRoot });
  assert.ok(lines.some(l => l.rule === 'sudo-unconfined'), JSON.stringify(lines));
  // without sudo the same lead is refused here (the probe says no, enforce): the hatch is sudo only
  const d2 = wire.lockboxFor({ agentName: 'lead-a', tool: 'Bash', command: 'ls /tmp' });
  assert.ok(d2.refuse, JSON.stringify(d2));
});

test('wire: lead with sudo through the hub Bash takes today\'s path (bash -c)', async () => {
  const w = world();
  const wire = wireFor(w, { agents: [{ name: 'lead-a', category: 'primary', lead: true, lockbox: 'enforce' }], probe: badProbe });
  const command = 'sudo -n true 2>/dev/null; echo after';
  let text;
  const calls = await recordSpawns(async () => { text = (await createHubTools({ cwd: w.ws, log: () => {}, lockboxFor: (o) => wire.lockboxFor({ ...o, agentName: 'lead-a' }) }).call('Bash', { command })).text; });
  assert.ok(/after/.test(text), text);
  assert.strictEqual(calls[0][0], 'bash');
  assert.deepStrictEqual(calls[0][1], ['-c', command]);
});

test('wire: an exception inside never escapes: enforce refuses, watch runs plainly', () => {
  const w = world();
  const boom = { ...lb, resolveMode: lb.resolveMode, decide: () => { throw new Error('boom'); } };
  const mk = (lockbox) => createWire({ getAgents: () => [AGENT_ENFORCE, { name: 'agent-w', category: 'worker', lockbox: 'watch' }], getVirtual: () => null, getSetting: () => undefined, lockbox, policyFor: policyIn(w) });
  const wire = mk(boom);
  assert.ok(wire.lockboxFor({ agentName: 'agent-a', tool: 'Bash', command: 'ls' }).refuse);
  assert.deepStrictEqual(wire.lockboxFor({ agentName: 'agent-w', tool: 'Bash', command: 'ls' }), { mode: 'watch', plain: true });
});

test('wire: an unknown agent name follows the hub default (enforce refuses, watch runs plainly, off is off)', () => {
  const w = world();
  const withDefault = (v) => wireFor(w, { agents: [AGENT_OFF], setting: (k) => (k === 'lockboxDefault' ? v : undefined), probe: okProbe });
  const ask = (wire) => wire.lockboxFor({ agentName: 'nobody', tool: 'Bash', command: 'ls' });
  const enforce = ask(withDefault('enforce'));
  assert.strictEqual(enforce.mode, 'enforce');
  assert.ok(typeof enforce.refuse === 'string' && enforce.refuse.length > 0, JSON.stringify(enforce));
  assert.ok(!enforce.profile && !enforce.plain);
  assert.deepStrictEqual(ask(withDefault('watch')), { mode: 'watch', plain: true });
  assert.deepStrictEqual(ask(withDefault('off')), { mode: 'off' });
});

test('sdkHook: a clientCommand that throws blocks in enforce and lets the call through in watch', async () => {
  const w = world();
  const stub = { clientCommand: () => { throw new Error('cannot wrap'); } };
  const hookInput = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hi' } };
  const hookFor = (mode) => createGate({ getAgent: async () => AGENT_OFF, approvals: null, lockbox: stub, log: () => {},
    lockboxFor: () => ({ mode, profile: { v: 1 } }) }).sdkHook({ agentName: 'agent-a', cwd: w.ws });
  const blocked = await hookFor('enforce')(hookInput);
  assert.strictEqual(blocked.decision, 'block');
  assert.match(blocked.reason, /cannot wrap/);
  assert.deepStrictEqual(await hookFor('watch')(hookInput), {});
});

test('sdkHook notes the call\'s Claude session, and the box grants that session\'s tool-results only', async () => {
  const w = world();
  const lb = require('../lib/lockbox');
  lb._resetSessions();
  const sid = 'c0ffee00-1234-4abc-8def-00000000beef';
  const hook = createGate({ getAgent: async () => AGENT_OFF, approvals: null, lockbox: lb, log: () => {}, lockboxFor: () => ({ mode: 'off' }) }).sdkHook({ agentName: 'agent-a', cwd: w.ws });
  await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(w.ws, 'x') }, session_id: sid });
  assert.deepStrictEqual(lb.sessionsFor('agent-a'), [sid]);
  const wire = wireFor(w, { agents: [AGENT_ENFORCE], probe: okProbe });
  const d = wire.lockboxFor({ agentName: AGENT_ENFORCE.name, tool: 'Bash', command: 'ls', cwd: w.ws });
  if (AGENT_ENFORCE.name === 'agent-a' && d.profile && d.profile.readHoles.length) {
    assert.ok(d.profile.readAllow.every(p => p.includes(sid) && p.endsWith('tool-results')), JSON.stringify(d.profile.readAllow));
  }
  lb._resetSessions();
});

// ── hub Bash, enforce ────────────────────────────────────────────────

test('hub Bash, refuse: the Error text comes back and nothing runs', async () => {
  const w = world();
  const wire = wireFor(w, { agents: [AGENT_ENFORCE], probe: badProbe });
  const marker = path.join(w.ws, 'ran.txt');
  let text;
  const calls = await recordSpawns(async () => { text = (await createHubTools({ cwd: w.ws, log: () => {}, lockboxFor: (o) => wire.lockboxFor({ ...o, agentName: 'agent-a' }) }).call('Bash', { command: 'touch ' + marker })).text; });
  assert.match(text, /^Error: The command lockbox is set to enforce for this agent, but it cannot run on this computer \(no landlock\)/);
  assert.strictEqual(calls.length, 0, 'nothing was spawned');
  assert.ok(!fs.existsSync(marker));
});

test('hub Bash, enforce: writes in its workspace, not outside; the hint line; no parent secrets in the environment', { skip: NO_BOX }, async () => {
  const w = world();
  const wire = wireFor(w, { agents: [AGENT_ENFORCE], rolesAdmin: BOX_OK });
  process.env.LOCKBOX_WIRE_SECRET = 'sekrit-value';
  try {
    const tools = createHubTools({ cwd: w.ws, log: () => {}, lockboxFor: (o) => wire.lockboxFor({ ...o, agentName: 'agent-a', sandboxed: false }) });
    const inside = await tools.call('Bash', { command: 'echo hi > ' + path.join(w.ws, 'f.txt') + '; cat ' + path.join(w.ws, 'f.txt') });
    assert.strictEqual(inside.text, 'hi');
    const target = path.join(w.outside, 'f.txt');
    const outside = await tools.call('Bash', { command: 'echo hi > ' + target });
    assert.match(outside.text, /^Error \(exit 1\):/);
    assert.match(outside.text, /Permission denied/);
    assert.ok(outside.text.endsWith('[lockbox] This command ran in the command lockbox (enforce): writes only in your own folders, no secret files, no unix sockets (docker, systemd). A "Permission denied" above may come from it.'), outside.text);
    assert.ok(!fs.existsSync(target));
    const env = await tools.call('Bash', { command: 'printenv LOCKBOX_WIRE_SECRET; echo end' });
    assert.strictEqual(env.text, 'end', 'the hub\'s variable is not in the box');
    const free = await createHubTools({ cwd: w.ws, log: () => {} }).call('Bash', { command: 'printenv LOCKBOX_WIRE_SECRET; echo end' });
    assert.strictEqual(free.text, 'sekrit-value\nend', 'control: unboxed it is there');
    const other = await tools.call('Bash', { command: 'ls /nonexistent-lockbox-path' });
    assert.ok(!other.text.includes('[lockbox]'), 'no hint for an ordinary failure');
  } finally { delete process.env.LOCKBOX_WIRE_SECRET; }
});

test('hub Bash, enforce: a temporary worker\'s box is its parent\'s mode and folder', { skip: NO_BOX }, async () => {
  const w = world();
  const wire = wireFor(w, { agents: [AGENT_ENFORCE], virtual: (n) => (n === 'tw-1' ? { parent: 'agent-a' } : null), rolesAdmin: BOX_OK });
  const tools = createHubTools({ cwd: w.share, log: () => {}, lockboxFor: (o) => wire.lockboxFor({ ...o, agentName: 'tw-1' }) });
  const own = path.join(lb.agentDirs('agent-a', { hubHome: w.hubHome }).tmp, 'x.txt');
  assert.strictEqual((await tools.call('Bash', { command: 'echo ok > ' + own + '; cat ' + own })).text, 'ok');
  const t = await tools.call('Bash', { command: 'echo no > ' + path.join(w.outside, 'y.txt') });
  assert.match(t.text, /Permission denied/);
});

// ── run_job ──────────────────────────────────────────────────────────

test('run_job, enforce: wrapper.sh carries jobLine, job.lockbox is the mode, the job runs boxed; a refuse writes nothing', { skip: NO_BOX }, async () => {
  const w = world();
  const wire = wireFor(w, { agents: [AGENT_ENFORCE], rolesAdmin: BOX_OK });
  const dataDir = tmp('lockbox-jobs-');
  const runner = new JobRunner({ dataDir, spawnMode: 'setsid', log: () => {}, defaultCwd: async () => w.ws, lockboxFor: (a) => wire.lockboxFor(a) });
  const target = path.join(w.outside, 'job.txt');
  const j = await runner.run({ owner: 'agent-a', name: 'boxed', command: 'echo in > ' + path.join(w.ws, 'job-in.txt') + '; echo out > ' + target + '; echo done', cwd: w.ws });
  assert.strictEqual(j.lockbox, 'enforce');
  const dir = path.join(dataDir, 'jobs', j.id);
  const wrapper = fs.readFileSync(path.join(dir, 'wrapper.sh'), 'utf8');
  const line = wrapper.split('\n').find(l => l.includes('lockbox-run.py'));
  assert.ok(line && line.endsWith(' > "$D/out.log" 2>&1'), wrapper);
  const profile = JSON.parse(Buffer.from(/--profile-b64 '([^']+)'/.exec(line)[1], 'base64').toString('utf8'));
  assert.strictEqual(line, lb.jobLine(profile) + ' > "$D/out.log" 2>&1');
  assert.ok(!wrapper.includes('\nbash "$D/job.sh"'));
  assert.ok(wrapper.includes('echo $$ > "$D/pid"') && wrapper.includes('echo $rc > "$D/exit.tmp"'), 'the rest of the wrapper is unchanged');
  assert.ok(await until(() => fs.existsSync(path.join(dir, 'exit'))), 'the job ended');
  assert.ok(fs.existsSync(path.join(w.ws, 'job-in.txt')), 'wrote in its workspace');
  assert.ok(!fs.existsSync(target), 'could not write outside');
  const out = fs.readFileSync(path.join(dir, 'out.log'), 'utf8');
  assert.match(out, /Permission denied/);
  assert.match(out, /done/);
  runner.stop();
});

test('run_job, refuse: it throws the text, nothing is written and nothing spawned', async () => {
  const w = world();
  const wire = wireFor(w, { agents: [AGENT_ENFORCE], probe: badProbe });
  const dataDir = tmp('lockbox-jobs-');
  const runner = new JobRunner({ dataDir, spawnMode: 'setsid', log: () => {}, defaultCwd: async () => w.ws, lockboxFor: (a) => wire.lockboxFor(a) });
  let err = null;
  try { await runner.run({ owner: 'agent-a', name: 'refused', command: 'echo hi', cwd: w.ws }); } catch (e) { err = e; }
  assert.ok(err && /cannot run on this computer \(no landlock\)/.test(err.message), err && err.message);
  assert.ok(!fs.existsSync(path.join(dataDir, 'jobs')) || fs.readdirSync(path.join(dataDir, 'jobs')).filter(n => n !== 'index.json').length === 0, 'no job folder');
  assert.strictEqual(runner.jobs.size, 0);
});

test('run_job: a sandboxed owner\'s job is never boxed here (it runs in its container)', async () => {
  const w = world();
  let asked = 0;
  const dataDir = tmp('lockbox-jobs-');
  const runner = new JobRunner({ dataDir, spawnMode: 'setsid', log: () => {}, defaultCwd: async () => w.ws, boxFor: async () => ({ name: 'c1', mounts: [w.ws] }), lockboxFor: () => { asked++; return { mode: 'enforce', refuse: 'no' }; } });
  const j = await runner.run({ owner: 'agent-a', name: 'in-box', command: 'echo hi', cwd: w.ws });
  assert.strictEqual(asked, 0);
  assert.strictEqual(j.lockbox, undefined);
  assert.ok(!fs.readFileSync(path.join(dataDir, 'jobs', j.id, 'wrapper.sh'), 'utf8').includes('lockbox-run'));
  runner.stop();
});

// ── the client's own Bash ────────────────────────────────────────────

test('sdkHook, enforce: the command is rewritten; it writes in the root, fails outside, and the outer shell follows its cd', { skip: NO_BOX }, async () => {
  // The rewritten command keeps the shell's folder in a file in /tmp (as every agent's roots include /tmp in production),
  // so /tmp is a root here and the "outside" folder is made in the home folder instead.
  let outDir;
  try { outDir = fs.mkdtempSync(path.join(os.homedir(), '.lockbox-wire-out-')); } catch (e) { return; }   // no writable home folder here
  try {
  const w = world();
  // /tmp as a root must not cover the lockbox folders (a box is refused if it would), so the hub home is in the home folder too.
  w.hubHome = path.join(outDir, 'hub-home');
  w.share = path.join(w.hubHome, 'share');
  fs.mkdirSync(w.share, { recursive: true });
  w.outside = path.join(outDir, 'elsewhere');
  fs.mkdirSync(w.outside);
  const head = { name: 'lead-a', category: 'primary', lead: true, lockbox: 'enforce' };   // the lead: no write holes to carve out of /tmp; a write outside is an ask, allowed with cards off
  const wire = wireFor(w, { agents: [head], rolesAdmin: BOX_OK, extraRoots: ['/tmp'] });
  const gate = createGate({ getAgent: async () => head, approvals: null, approvalsOn: () => false, lockboxFor: wire.lockboxFor });
  const hook = gate.sdkHook({ agentName: head.name, cwd: w.ws });
  const inner = 'mkdir -p sub && cd sub && echo ok > in.txt; echo bad > ' + path.join(w.outside, 'o.txt') + '; echo finished';
  const r = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: inner, description: 'x' } });
  assert.ok(r.hookSpecificOutput, JSON.stringify(r));
  assert.strictEqual(r.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(r.hookSpecificOutput.permissionDecision, 'allow');
  assert.strictEqual(r.hookSpecificOutput.updatedInput.description, 'x', 'the other input fields are kept');
  const rewritten = r.hookSpecificOutput.updatedInput.command;
  assert.notStrictEqual(rewritten, inner);
  const run = cp.spawnSync('bash', ['-c', rewritten + '\npwd'], { cwd: w.ws, encoding: 'utf8' });
  assert.match(run.stdout, /finished/, run.stderr);
  assert.strictEqual(run.stdout.trim().split('\n').pop(), path.join(w.ws, 'sub'), 'the outer shell is in the folder the inner command cd\'ed into');
  assert.ok(fs.existsSync(path.join(w.ws, 'sub', 'in.txt')));
  assert.ok(!fs.existsSync(path.join(w.outside, 'o.txt')));
  assert.match(run.stderr, /Permission denied/);
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});

test('sdkHook, refuse: a block with the text', async () => {
  const w = world();
  const wire = wireFor(w, { agents: [AGENT_ENFORCE], probe: badProbe });
  const hook = createGate({ getAgent: async () => AGENT_ENFORCE, approvals: null, lockboxFor: wire.lockboxFor }).sdkHook({ agentName: 'agent-a', cwd: w.ws });
  const r = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.strictEqual(r.decision, 'block');
  assert.match(r.reason, /command lockbox is set to enforce/);
});

// ── widening after a person's approval ───────────────────────────────

test('gate: only an approval by a person widens (a stub lockbox sees what is noted)', async () => {
  const home = os.homedir();
  const target = path.join(home, 'lockbox-wire-never-created.txt');
  const command = 'cp /etc/hostname ' + target;
  const head = { name: 'head-a', category: 'primary' };
  const notes = [];
  const stub = { noteApproval: (n) => notes.push(n), clientCommand: () => { throw new Error('not here'); } };
  const mk = (approvalsOn, approvals) => createGate({ getAgent: async () => head, approvals, allowances: null, approvalsOn: () => approvalsOn, lockboxFor: () => ({ mode: 'off' }), lockbox: stub, lockboxAgentName: (n) => n, log: () => {} });
  const input = { command };

  const ap1 = createApprovals({ timeoutMs: 5000, log: () => {} });
  const r1 = await mk(true, ap1).check({ agentName: 'head-a', tool: 'mcp__hub__Bash', input, cwd: home, notify: (ev) => { if (ev.type === 'approval_request') setImmediate(() => ap1.resolve(ev.id, 'allow')); } });
  assert.ok(r1.allowed && r1.by === 'owner');
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].agent, 'head-a');
  assert.strictEqual(notes[0].command, command);
  assert.deepStrictEqual(notes[0].writes, [home], 'a new file widens its folder');
  assert.deepStrictEqual(notes[0].reads, []);

  const ap2 = createApprovals({ timeoutMs: 40, log: () => {} });
  const r2 = await mk(true, ap2).check({ agentName: 'head-a', tool: 'mcp__hub__Bash', input, cwd: home });
  assert.ok(!r2.allowed && r2.by === 'timeout');
  const ap3 = createApprovals({ timeoutMs: 5000, log: () => {} });
  const r3 = await mk(true, ap3).check({ agentName: 'head-a', tool: 'mcp__hub__Bash', input, cwd: home, notify: (ev) => { if (ev.type === 'approval_request') setImmediate(() => ap3.resolve(ev.id, 'deny')); } });
  assert.ok(!r3.allowed);
  const r4 = await mk(false, createApprovals({ log: () => {} })).check({ agentName: 'head-a', tool: 'mcp__hub__Bash', input, cwd: home });
  assert.ok(r4.allowed && !r4.by, 'cards off: allowed without a person');
  const ap5 = createApprovals({ timeoutMs: 5000, log: () => {} });
  const r5 = await mk(true, ap5).check({ agentName: 'head-a', tool: 'Write', input: { file_path: target }, cwd: home, notify: (ev) => { if (ev.type === 'approval_request') setImmediate(() => ap5.resolve(ev.id, 'allow')); } });
  assert.ok(r5.allowed);
  assert.strictEqual(notes.length, 1, 'timeout, denial, cards off and a non-shell tool never widen');

  const ap6 = createApprovals({ timeoutMs: 5000, log: () => {} });
  const noLockbox = createGate({ getAgent: async () => head, approvals: ap6, allowances: null, approvalsOn: () => true, lockbox: stub, log: () => {} });   // no lockboxFor: no noting at all
  assert.ok((await noLockbox.check({ agentName: 'head-a', tool: 'mcp__hub__Bash', input, cwd: home, notify: (ev) => { if (ev.type === 'approval_request') setImmediate(() => ap6.resolve(ev.id, 'allow')); } })).allowed);
  assert.strictEqual(notes.length, 1);
});

test('widening end to end: one approved command writes outside its roots, the same command again does not', { skip: NO_BOX }, async () => {
  let outDir;
  try { outDir = fs.mkdtempSync(path.join(os.homedir(), '.lockbox-wire-out-')); } catch (e) { return; }   // no writable home folder here
  try {
    lb._resetApprovals();
    const w = world();
    const head = { name: 'head-a', category: 'primary', lockbox: 'enforce' };
    const wire = wireFor(w, { agents: [head], rolesAdmin: BOX_OK });
    const src = path.join(w.share, 'src.txt');
    fs.writeFileSync(src, 'payload');
    const target = path.join(outDir, 'copied.txt');
    const command = 'cp ' + src + ' ' + target;
    const approvals = createApprovals({ timeoutMs: 5000, log: () => {} });
    const gate = createGate({ getAgent: async () => head, approvals, allowances: null, approvalsOn: () => true, lockboxFor: wire.lockboxFor, lockboxAgentName: wire.approvalNameFor, log: () => {} });
    const verdict = await gate.check({ agentName: 'head-a', tool: 'mcp__hub__Bash', input: { command }, cwd: w.share, notify: (ev) => { if (ev.type === 'approval_request') setImmediate(() => approvals.resolve(ev.id, 'allow')); } });
    assert.ok(verdict.allowed && verdict.by === 'owner', JSON.stringify(verdict));
    const tools = createHubTools({ cwd: w.share, log: () => {}, lockboxFor: (o) => wire.lockboxFor({ ...o, agentName: 'head-a' }) });
    const first = await tools.call('Bash', { command });
    assert.ok(fs.existsSync(target), first.text);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'payload');
    fs.rmSync(target);
    const second = await tools.call('Bash', { command });
    assert.match(second.text, /Permission denied/);
    assert.ok(!fs.existsSync(target), 'the approval was for one run');
    // a command nobody approved gets nothing extra
    const third = await tools.call('Bash', { command: 'cp ' + src + ' ' + path.join(outDir, 'other.txt') });
    assert.match(third.text, /Permission denied/);
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});

// ── tool-policy ──────────────────────────────────────────────────────

test('pathsOf: the outside write path and an admin read path; nothing for inside paths', () => {
  const w = world();
  const roots = [w.ws, w.share];
  const opts = { cwd: w.ws, roots, agentName: 'agent-a' };
  assert.deepStrictEqual(toolPolicy.pathsOf('cp a /x/y', opts), { writes: ['/x/y'], reads: [] });
  const secret = path.join(toolPolicy.HUB_ROOT, 'data', 'users.json');   // a string only: the file is never opened
  assert.deepStrictEqual(toolPolicy.pathsOf('cat ' + secret, opts), { writes: [], reads: [secret] });
  assert.deepStrictEqual(toolPolicy.pathsOf('cp a ' + path.join(w.ws, 'b') + ' && cat ' + path.join(w.share, 'c'), opts), { writes: [], reads: [] });
  assert.deepStrictEqual(toolPolicy.pathsOf('echo hi > ' + path.join(w.outside, 'z.txt') + '; ls', { ...opts, roots: [w.ws] }), { writes: [path.join(w.outside, 'z.txt')], reads: [] });
  assert.deepStrictEqual(toolPolicy.pathsOf('', opts), { writes: [], reads: [] });
  const admin = toolPolicy.pathsOf('touch ' + secret, opts);
  assert.deepStrictEqual(admin.writes, [secret], 'a write to hub data is above every baseline too');
});
