'use strict';
// Agent sandboxes (lib/sandbox): mode resolution, what gets mounted, the container's hardening flags, the client
// wrapper, credential sync and command execution, all against a fake docker.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSandbox } = require('../lib/sandbox');

function rig(o = {}) {
  const calls = [];
  const states = o.states || {};          // container name -> status string ('running'|'exited'|null)
  const docker = async (args) => {
    calls.push(args);
    const cmd = args[0];
    if (cmd === 'image' && o.noImage) throw new Error('No such image');
    if (cmd === 'version' && o.noDocker) throw new Error('docker: not found');
    if (cmd === 'inspect') { const st = states[args[args.length - 1]]; if (!st) throw new Error('No such container'); return { stdout: st + '\n', stderr: '' }; }
    if (cmd === 'create') { states[args[args.indexOf('--name') + 1]] = 'created'; return { stdout: 'id\n', stderr: '' }; }
    if (cmd === 'start') { states[args[args.length - 1]] = 'running'; return { stdout: '', stderr: '' }; }
    if (cmd === 'exec') {
      const i = args.indexOf('stat'); if (i >= 0) { if (o.credStale === false) return { stdout: String(Math.floor(Date.now() / 1000) + 100) + '\n', stderr: '' }; throw new Error('no file'); }
      if (args.includes('bash')) return o.execResult ? o.execResult(args[args.length - 1]) : { stdout: `ran: ${args[args.length - 1]}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    }
    if (cmd === 'ps') return { stdout: 'hub-agent-boxed\tUp 2 minutes\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
  const creds = path.join(dir, '.credentials.json'); fs.writeFileSync(creds, '{"tok":1}');
  const ws = (a) => path.join(dir, 'workspaces', a.name);
  const sb = createSandbox({
    docker, wrapperDir: path.join(dir, 'wrappers'), credentialsFile: creds, uid: 1000, gid: 1000, image: 'agent-hub-sandbox:test', log: () => {},
    getSetting: (k) => (o.settings || {})[k],
    isMemberOwned: (a) => !!(a && a.owner && a.owner !== 'admin1'),
    rootsFor: o.rootsFor || ((a) => [os.tmpdir(), '/tmp', path.join(require('../lib/tool-policy').HUB_HOME, 'share'), ws(a), path.join(dir, 'users', String(a.owner || 'x')), path.join(require('../lib/tool-policy').HUB_HOME, 'agent-hub-5.1.0')]),
    workspaceFor: ws,
  });
  fs.mkdirSync(path.join(dir, 'users', 'member1'), { recursive: true });
  return { sb, calls, dir, ws, states };
}
const member = { name: 'boxed', model: 'claude-sdk/claude-haiku-5-5', owner: 'member1' };
const adminAgent = { name: 'worker', model: 'claude-sdk/claude-sonnet-5-5', owner: 'admin1' };
const gatewayMember = { name: 'gw', model: 'openai/gpt-5.6-sol', owner: 'member1' };

test('mode: members default to container, admins to off; an agent\'s own setting wins; defaults are owner-editable', () => {
  const { sb } = rig();
  assert.equal(sb.mode(member), 'container');
  assert.equal(sb.mode(adminAgent), 'off');
  assert.equal(sb.mode({ ...adminAgent, sandbox: 'container' }), 'container');
  assert.equal(sb.mode({ ...member, sandbox: 'off' }), 'off');
  assert.equal(sb.mode(null), 'off');
  const r2 = rig({ settings: { sandboxDefaults: { member: 'off', admin: 'container' } } });
  assert.equal(r2.sb.mode(member), 'off'); assert.equal(r2.sb.mode(adminAgent), 'container');
});

test('mounts: the agent\'s workspace and owner tree, never the hub tree, the data dir, the whole share folder or /tmp', () => {
  const { sb, dir, ws } = rig();
  fs.mkdirSync(ws(member), { recursive: true });
  const m = sb.mountsFor(member);
  assert.ok(m.includes(ws(member)));
  assert.ok(m.includes(path.join(dir, 'users', 'member1')));
  for (const bad of ['/tmp', os.tmpdir(), path.join(require('../lib/tool-policy').HUB_HOME, 'share'), path.join(require('../lib/tool-policy').HUB_HOME, 'agent-hub-5.1.0')]) assert.ok(!m.includes(bad), `${bad} must not be mounted`);
});

test('ensure: creates a hardened container (no caps, read-only root, user, pid limit, same-path mounts), network none for gateway agents and bridge for Claude-client agents; reuses a running one', async () => {
  const { sb, calls, ws } = rig();
  fs.mkdirSync(ws(member), { recursive: true });
  await sb.ensure(member);
  const create = calls.find(a => a[0] === 'create');
  const s = create.join(' ');
  for (const flag of ['--cap-drop ALL', '--read-only', '--user 1000:1000', '--pids-limit', '--security-opt no-new-privileges', '--network bridge', `-v ${ws(member)}:${ws(member)}`, 'hub-agent-boxed-home:/home/agent', '--workdir ' + ws(member)]) assert.ok(s.includes(flag), flag);
  assert.ok(!s.includes('agent-hub-5.1.0/data'), 'hub data never mounted');
  calls.length = 0;
  await sb.ensure(member);
  assert.ok(!calls.some(a => a[0] === 'create'), 'running container reused');
  const g = rig(); fs.mkdirSync(g.ws(gatewayMember), { recursive: true });
  await g.sb.ensure(gatewayMember);
  assert.ok(g.calls.find(a => a[0] === 'create').join(' ').includes('--network none'), 'gateway agents get no network');
});

test('wrapper: the SDK launches a script that execs the client inside the box forwarding only the listed variables', () => {
  const { sb } = rig();
  const file = sb.wrapperPath(member);
  const body = fs.readFileSync(file, 'utf8');
  assert.ok(body.startsWith('#!/bin/sh'));
  assert.ok(body.includes("docker exec -i -w") && body.includes("'hub-agent-boxed' claude \"$@\""));
  assert.ok(body.includes('-e CLAUDE_CODE_AUTO_COMPACT_WINDOW') && !body.includes('OPENAI') && !body.includes('ANTHROPIC_API_KEY'));
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '700');
});

test('prepare: null when Docker or the image is missing (caller withholds the shell); otherwise container + credentials + wrapper + cwd', async () => {
  const none = rig({ noImage: true });
  assert.equal(await none.sb.prepare(member), null);
  const { sb, calls, ws } = rig();
  fs.mkdirSync(ws(member), { recursive: true });
  const p = await sb.prepare(member);
  assert.ok(p.pathToClaudeCodeExecutable.endsWith('boxed.sh'));
  assert.equal(p.cwd, ws(member));
  assert.ok(calls.some(a => a[0] === 'cp' && a[2] === 'hub-agent-boxed:/home/agent/.claude/.credentials.json'), 'credentials copied into the box');
  assert.ok(calls.some(a => a[0] === 'exec' && a.includes('chmod')), 'and made private');
  const fresh = rig({ credStale: false }); fs.mkdirSync(fresh.ws(member), { recursive: true });
  await fresh.sb.prepare(member);
  assert.ok(!fresh.calls.some(a => a[0] === 'cp'), 'not copied again when the box already has a current copy');
});

test('exec: shell commands run with docker exec in the agent\'s workspace; failures return the exit code instead of throwing', async () => {
  const { sb, calls, ws } = rig({ execResult: (cmd) => { if (cmd.includes('fail')) { const e = new Error('boom'); e.code = 2; e.stdout = ''; e.stderr = 'nope'; throw e; } return { stdout: 'ok\n', stderr: '' }; } });
  fs.mkdirSync(ws(member), { recursive: true });
  const ok = await sb.exec(member, 'echo hi');
  assert.deepEqual([ok.stdout, ok.code], ['ok\n', 0]);
  const ex = calls.find(a => a[0] === 'exec' && a.includes('bash'));
  assert.deepEqual(ex.slice(0, 4), ['exec', '-w', ws(member), 'hub-agent-boxed']);
  const bad = await sb.exec(member, 'fail now');
  assert.deepEqual([bad.code, bad.stderr], [2, 'nope']);
  const none = rig({ noImage: true });
  await assert.rejects(none.sb.exec(member, 'x'), /sandbox unavailable/);
});

test('status: reports Docker, image and containers; wiring exists on both dispatch paths and the routes', async () => {
  const { sb } = rig();
  const st = await sb.status();
  assert.equal(st.docker, true); assert.equal(st.imageReady, true); assert.deepEqual(st.containers, [{ agent: 'boxed', container: 'hub-agent-boxed', status: 'Up 2 minutes' }]);
  const down = rig({ noDocker: true, noImage: true }); const sd = await down.sb.status(); assert.equal(sd.docker, false); assert.match(sd.error, /Docker/);
  const sdk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.ok(sdk.includes("sandboxOpts = await sb.prepare(recSb)"), 'SDK path prepares the box');
  assert.ok(sdk.includes("pathToClaudeCodeExecutable: sandboxOpts.pathToClaudeCodeExecutable, cwd: sandboxOpts.cwd"), 'SDK launches the wrapper in the workspace');
  assert.ok(sdk.includes("sandboxWithheld ? ['mcp__agent-hub__*'] : ["), 'shell withheld when no box');
  assert.ok(sdk.includes("? { PATH: process.env.PATH, HOME: process.env.HOME,"), 'minimal environment for a boxed client');
  assert.ok(sdk.includes("box = { exec: (cmd, o) => sb.exec(agent, cmd, o), mounts: sb.mountsFor(agent) }") && sdk.includes("if (hands.withheld) {"), 'gateway Bash runs in the box through the per-turn hands; withheld without one');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const r of ["'/api/sandbox/status'", "'/api/sandbox/build'", "(reset|stop)"]) assert.ok(srv.includes(r), r);
  const ag = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agents.js'), 'utf8');
  assert.ok(ag.includes("'minModel', 'sandbox', 'tools', 'effort']") && ag.includes("sandbox must be inherit, off or container"));
});

test('mounts: share/common is mounted for admin-side agents when it exists, never for a member\'s agent', () => {
  const { sb, ws } = rig();
  fs.mkdirSync(ws(adminAgent), { recursive: true }); fs.mkdirSync(ws(member), { recursive: true });
  const common = path.join(require('../lib/tool-policy').HUB_HOME, 'share', 'common');
  const admin = sb.mountsFor(adminAgent), mem = sb.mountsFor(member);
  if (fs.existsSync(common)) assert.ok(admin.includes(common), 'admin-side agent sees share/common');
  assert.ok(!mem.includes(common), 'a member\'s agent does not');
  // the server rebuilds the box when folders, sandbox mode or hands change
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(server.includes("['policy', 'sandbox', 'tools'].some(k => k in body)") && server.includes("require('./lib/sandbox').getSandbox().remove(rec)"));
  const sdk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.ok(sdk.includes('boxFor: async (owner) => {') && sdk.includes('return { name, mounts: sb.mountsFor(agent) };'), 'jobs run inside the box');
});

test('a box a backup left paused is let go when its agent needs it; one paused by someone else is not; a test can never reach the real Docker', async () => {
  const { createSandbox, holdLaunches } = require('../lib/sandbox');
  const calls = [];
  const FULL = 'abc123def456' + '0'.repeat(52);
  const docker = async (args) => { calls.push(args.join(' ')); if (args[0] === 'inspect') return { stdout: args[2] === '{{.Id}}' ? `${FULL}\n` : 'paused\n', stderr: '' }; return { stdout: '', stderr: '' }; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-heal-'));
  const pauseRecord = path.join(dir, 'backup-paused.json');
  const sb = createSandbox({ docker, wrapperDir: dir, log: () => {}, pauseRecord });
  // not recorded by a backup (an operator froze it): left paused, and the agent can't start
  await assert.rejects(sb.ensure({ name: 'healme' }), (e) => e.code === 'EPAUSED');
  assert.ok(!calls.some(c => c.startsWith('unpause')), 'not let go');
  fs.writeFileSync(pauseRecord, JSON.stringify({ ids: ['abc123def456'] }));
  assert.strictEqual(await sb.ensure({ name: 'healme' }), 'hub-agent-healme');
  assert.ok(calls.includes('unpause hub-agent-healme'), 'a box the backup recorded: let go');
  // while a backup holds launches, nothing is let go (the start waits for the hold instead)
  calls.length = 0;
  const letGo = await holdLaunches({ timeoutMs: 60000 });
  let done = false; const p = sb.ensure({ name: 'healme' }).then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(done, false);
  assert.deepStrictEqual(calls, []);
  letGo(); await p;
  // without a stand-in, the real Docker is refused inside the test runner
  const real = createSandbox({ wrapperDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-real-')), log: () => {} });
  await assert.rejects(real.ensure({ name: 'anything' }), /A test tried to use the real Docker/, 'never a real call');
});

