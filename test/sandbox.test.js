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
    if (cmd === 'inspect') {
      const st = states[args[args.length - 1]]; if (!st) throw new Error('No such container');
      if (args.includes('{{.HostConfig.Init}}')) {
        if (o.initError) throw new Error('context deadline exceeded');
        if (o.onInit) await o.onInit(states, args[args.length - 1]);   // a hook run while the Init answer is awaited
        return { stdout: o.init === false ? 'false\n' : (o.init === 'absent' ? '<no value>\n' : (o.init === 'nil' ? '<nil>\n' : 'true\n')), stderr: '' };
      }
      if (o.binds && String(args[2]).includes('.Mounts')) return { stdout: o.binds().map(b => `${b}\n`).join(''), stderr: '' };
      return { stdout: st + '\n', stderr: '' };
    }
    if (cmd === 'create') { states[args[args.indexOf('--name') + 1]] = 'created'; return { stdout: 'id\n', stderr: '' }; }
    if (cmd === 'start') { states[args[args.length - 1]] = 'running'; return { stdout: '', stderr: '' }; }
    if (cmd === 'rm') {   // like Docker: a running or paused box is refused without -f; a removed box is gone
      const n = args[args.length - 1];
      if (args.includes('-f')) { delete states[n]; return { stdout: '', stderr: '' }; }
      if (states[n] === 'running' || states[n] === 'paused') throw new Error('You cannot remove a running container');
      delete states[n]; return { stdout: '', stderr: '' };
    }
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
    docker, wrapperDir: path.join(dir, 'wrappers'), credentialsFile: creds, uid: 1000, gid: 1000, image: 'agent-hub-sandbox:test', log: o.log || (() => {}),
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
  for (const flag of ['--cap-drop ALL', '--read-only', '--user 1000:1000', '--pids-limit', '--security-opt no-new-privileges', '--network bridge', '--init', `-v ${ws(member)}:${ws(member)}`, 'hub-agent-boxed-home:/home/agent', '--workdir ' + ws(member)]) assert.ok(s.includes(flag), flag);
  assert.ok(!s.includes('agent-hub-5.1.0/data'), 'hub data never mounted');
  calls.length = 0;
  await sb.ensure(member);
  assert.ok(!calls.some(a => a[0] === 'create'), 'running container reused');
  const g = rig(); fs.mkdirSync(g.ws(gatewayMember), { recursive: true });
  await g.sb.ensure(gatewayMember);
  assert.ok(g.calls.find(a => a[0] === 'create').join(' ').includes('--network none'), 'gateway agents get no network');
});

test('ensure: a stopped box with the right folders and an init process is started, not made again', async () => {
  const name = 'hub-agent-boxed';
  const r2 = rig({ states: { [name]: 'exited' }, init: true, binds: () => r2.sb.mountsFor(member) });
  fs.mkdirSync(r2.ws(member), { recursive: true });
  assert.strictEqual(await r2.sb.ensure(member), name);
  assert.deepStrictEqual(r2.calls.filter(a => ['rm', 'create', 'start'].includes(a[0])), [['start', name]]);
});

test('ensure: a stopped box with the right folders but made without an init process (false or absent) is made again with --init, same mounts and home volume; the log says so', async () => {
  for (const init of [false, 'absent']) {
    const name = 'hub-agent-boxed';
    const logs = [];
    const fresh = rig(); fs.mkdirSync(fresh.ws(member), { recursive: true });
    await fresh.sb.ensure(member);
    const freshCreate = fresh.calls.find(a => a[0] === 'create');
    const r = rig({ states: { [name]: 'exited' }, init, log: (m) => logs.push(m), binds: () => r.sb.mountsFor(member) });
    fs.mkdirSync(r.ws(member), { recursive: true });
    assert.strictEqual(await r.sb.ensure(member), name);
    const rm = r.calls.findIndex(a => a.join(' ') === `rm ${name}`), create = r.calls.findIndex(a => a[0] === 'create');
    assert.ok(rm >= 0 && create > rm, 'removed, then created');
    assert.ok(!r.calls.some(a => a[0] === 'rm' && a.includes('-f')), 'never rm -f');
    const args = r.calls[create];
    assert.ok(args.includes('--init'));
    const vols = (a) => a.map((x, i) => (a[i - 1] === '-v' ? x : null)).filter(Boolean);
    assert.deepStrictEqual(vols(args), ['hub-agent-boxed-home:/home/agent', ...r.sb.mountsFor(member).map(m => `${m}:${m}`)], 'same -v mounts and home volume as a fresh box');
    assert.strictEqual(vols(args).length, vols(freshCreate).length);
    assert.ok(vols(args).includes('hub-agent-boxed-home:/home/agent'));
    assert.ok(logs.includes(`${name} was made without an init process; making it again`), String(init));
  }
});

test('ensure: a running box made without an init process is never touched', async () => {
  const name = 'hub-agent-boxed';
  const r = rig({ states: { [name]: 'running' }, init: false });
  fs.mkdirSync(r.ws(member), { recursive: true });
  assert.strictEqual(await r.sb.ensure(member), name);
  assert.ok(!r.calls.some(a => a.includes('{{.HostConfig.Init}}')), 'init not even looked at');
  assert.ok(!r.calls.some(a => ['rm', 'create', 'start'].includes(a[0])));
});

const initTest = (o, name = 'hub-agent-boxed') => {
  const logs = [];
  const r = rig({ states: { [name]: 'exited' }, log: (m) => logs.push(m), binds: () => r.sb.mountsFor(member), ...o });
  fs.mkdirSync(r.ws(member), { recursive: true });
  return { r, logs, name, did: () => r.calls.filter(a => ['rm', 'create', 'start'].includes(a[0])).map(a => a.join(' ').split(' --')[0]) };
};

test('ensure: two concurrent calls for one agent whose stopped box was made without init share one ensure: one rm, one create, one name', async () => {
  // Before the change: no per-name serialisation and rm -f, so the second caller (whose Init answer is not held) would also
  // remove and create the box: two rm and two creates.
  let release; const gate = new Promise(res => { release = res; });
  let n = 0;
  const { r, name } = initTest({ init: false, onInit: async () => { if (n++ === 0) await gate; } });
  const p1 = r.sb.ensure(member);
  await new Promise(res => setTimeout(res, 30));
  const p2 = r.sb.ensure(member);
  await new Promise(res => setTimeout(res, 30));
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.strictEqual(a, name); assert.strictEqual(b, name);
  assert.strictEqual(r.calls.filter(c => c[0] === 'rm').length, 1);
  assert.strictEqual(r.calls.filter(c => c[0] === 'create').length, 1);
  assert.ok(r.calls.find(c => c[0] === 'create').includes('--init'));
  assert.strictEqual(r.states[name], 'running');
  // the per-name entry is gone afterwards: a later ensure of the running box just returns it
  r.calls.length = 0;
  assert.strictEqual(await r.sb.ensure(member), name);
  assert.ok(!r.calls.some(c => ['rm', 'create', 'start'].includes(c[0])));
});

test('ensure: rm refused because the box is running again (started between the Init answer and the rm): the name is returned, nothing created', async () => {
  // Before the change rm -f would have removed the running box under its users and created another.
  const { r, logs, name } = initTest({ init: false, onInit: async (states, n) => { states[n] = 'running'; } });
  assert.strictEqual(await r.sb.ensure(member), name);
  assert.ok(r.calls.some(c => c.join(' ') === `rm ${name}`));
  assert.ok(!r.calls.some(c => c[0] === 'create'));
  assert.strictEqual(r.states[name], 'running');
  assert.ok(logs.some(l => l.includes('is running again; left as it is')), logs.join('|'));
});

test('ensure: rm refused for a paused box (a backup\'s hold): ensure throws, nothing created, the paused box is not removed', async () => {
  // Before the change rm -f removed the paused box.
  const { r, name } = initTest({ init: false, onInit: async (states, n) => { states[n] = 'paused'; } });
  await assert.rejects(() => r.sb.ensure(member), /cannot remove a running container/);
  assert.ok(!r.calls.some(c => c[0] === 'create'));
  assert.strictEqual(r.states[name], 'paused');
});

test('ensure: when the Init inspect itself errors, a stopped box with the right folders is started, not removed or made again', async () => {
  const { r, name, did } = initTest({ initError: true });
  assert.strictEqual(await r.sb.ensure(member), name);
  assert.deepStrictEqual(did(), [`start ${name}`]);
});

test('ensure: Init "<nil>" (Docker 29 for a box made without --init) means made again', async () => {
  const { r, name, did } = initTest({ init: 'nil' });
  assert.strictEqual(await r.sb.ensure(member), name);
  assert.deepStrictEqual(did(), [`rm ${name}`, 'create', `start ${name}`]);
});

test('ensure: other folders AND no init: made again with the "other folders" log line, not the init line', async () => {
  const { r, logs, name, did } = initTest({ init: false, binds: () => ['/somewhere/else'] });
  assert.strictEqual(await r.sb.ensure(member), name);
  assert.deepStrictEqual(did(), [`rm ${name}`, 'create', `start ${name}`]);
  assert.ok(logs.includes(`${name} was made for other folders; making it again`), logs.join('|'));
  assert.ok(!logs.some(l => l.includes('without an init process')));
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


test('retire: a deleted agent\'s box and home volume go; its home folder is kept as box-home.tar, without the sign-ins', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-retire-'));
  const into = path.join(dir, 'bundle'); fs.mkdirSync(into);
  const wrappers = path.join(dir, 'wrappers');
  const rigged = (o = {}) => {
    const calls = [];
    const have = { box: o.box !== false, vol: o.vol !== false };
    const fail = (msg, code) => Object.assign(new Error(msg), { stderr: msg, ...(code ? { code } : {}) });
    const docker = async (args) => {
      calls.push(args);
      const [a0, a1] = args;
      if (a0 === 'version') { if (o.version) throw o.version; return { stdout: '27.3\n', stderr: '' }; }
      if (a0 === 'container' && a1 === 'inspect') { if (o.inspectError) throw fail(o.inspectError); if (!have.box) throw fail('Error: No such container: hub-agent-gone'); return { stdout: `${IMG}\n`, stderr: '' }; }
      if (a0 === 'rm') { have.box = false; return { stdout: '', stderr: '' }; }
      if (a0 === 'volume' && a1 === 'inspect') { if (!have.vol) throw fail('Error response from daemon: get hub-agent-gone-home: no such volume'); return { stdout: 'v\n', stderr: '' }; }
      if (a0 === 'volume' && a1 === 'rm') { have.vol = false; return { stdout: '', stderr: '' }; }
      if (a0 === 'run') {
        const host = args.find(x => x.endsWith(':/bundle')).slice(0, -':/bundle'.length);
        fs.writeFileSync(path.join(host, path.basename(args[args.indexOf('-cf') + 1])), 'TAR');
        if (o.tarFails && o.tarFails-- > 0) throw fail('tar: ./.cache/locked: Cannot open: Permission denied');
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    return { sb: createSandbox({ docker, wrapperDir: wrappers, uid: 1000, gid: 1000, image: 'agent-hub-sandbox:test', log: () => {} }), calls, have };
  };
  const gone = { name: 'gone', model: 'claude-sdk/x' };
  // an agent made since boxes carry an id has a box of its own; an older one keeps the name-only box
  assert.strictEqual(rigged().sb.containerName({ name: 'gone', box: '0a1b2c3d4e5f' }), 'hub-agent-gone-0a1b2c3d4e5f');
  assert.strictEqual(rigged().sb.containerName({ name: 'gone', box: '../x' }), 'hub-agent-gone', 'an id that is not one is ignored');
  const r1 = rigged();
  assert.deepStrictEqual(await r1.sb.retire(gone, into, { boxed: true }), { result: 'removed; home kept as box-home.tar' });
  assert.ok(r1.calls.some(c => c.join(' ') === 'rm -f hub-agent-gone'));
  const tar = r1.calls.find(c => c[0] === 'run');
  for (const want of ['--network none', '--read-only', '--cap-drop ALL', '--user 1000:1000', '-v hub-agent-gone-home:/box-home:ro', `-v ${into}:/bundle`, `--entrypoint tar ${IMG} `,
    '--exclude ./.claude/.credentials.json', '--exclude ./.codex/auth.json']) assert.ok(tar.join(' ').includes(want), want);
  assert.ok(!tar.includes('--ignore-failed-read'), 'a file the copy can\'t read fails it');
  assert.deepStrictEqual(fs.readdirSync(into), ['box-home.tar'], 'kept under its own name, no temporary file left');
  assert.ok(r1.calls.some(c => c.join(' ') === 'volume rm hub-agent-gone-home'));
  assert.deepStrictEqual(await r1.sb.retire(gone, into, { boxed: true }), { result: 'none' }, 'again: nothing left to do');
  // A home already kept is never replaced.
  const r2 = rigged({ box: false });
  await r2.sb.retire(gone, into, {});
  assert.deepStrictEqual(fs.readdirSync(into).sort(), ['box-home-2.tar', 'box-home.tar']);
  // No Docker installed: there can be no box.
  assert.deepStrictEqual(await rigged({ version: fail0('spawn docker ENOENT', 'ENOENT') }).sb.retire(gone, into, { boxed: true }), { result: 'no Docker here' });
  // Docker not answering, or not usable by this account (that can change back): only an agent known to have had no box is done.
  for (const down of [fail0('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'), fail0('permission denied while trying to connect to the Docker daemon socket')]) {
    assert.deepStrictEqual(await rigged({ version: down }).sb.retire(gone, into, { boxed: false }), { result: 'Docker not answering; the agent had no box' });
    for (const boxed of [true, null]) await assert.rejects(rigged({ version: down }).sb.retire(gone, into, { boxed }), /^Error: Docker is not answering \((Cannot connect|permission denied)/);
  }
  // Any other failure to look is not "no box".
  await assert.rejects(rigged({ inspectError: 'context deadline exceeded' }).sb.retire(gone, into, {}), /context deadline exceeded/);
  // The copy of the home folder fails (a file it can't read): the volume stays for the next try, no part-copy is left,
  // and the next try still copies with the box's own image although the box itself is gone.
  const into3 = path.join(dir, 'bundle3'); fs.mkdirSync(into3);
  const r3 = rigged({ tarFails: 1 });
  await assert.rejects(r3.sb.retire(gone, into3, {}), /Permission denied/);
  assert.deepStrictEqual([r3.have.box, r3.have.vol], [false, true]);
  assert.deepStrictEqual(fs.readdirSync(into3), ['.box-image']);
  assert.deepStrictEqual(await r3.sb.retire(gone, into3, {}), { result: 'removed; home kept as box-home.tar' });
  assert.ok(r3.calls.filter(c => c[0] === 'run').every(c => c.includes(IMG)));
  assert.strictEqual(r3.have.vol, false);
  assert.deepStrictEqual(fs.readdirSync(into3), ['box-home.tar']);
  fs.rmSync(dir, { recursive: true, force: true });
});
const IMG = `sha256:${'ab'.repeat(32)}`;
function fail0(msg, code) { return Object.assign(new Error(msg), { stderr: msg, ...(code ? { code } : {}) }); }

test('a stopped box made for other folders is made again instead of started (a renamed agent, folders changed while a removal failed)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-remake-'));
  const ws = (a) => path.join(dir, 'workspaces', a.name);
  const boxes = {};   // name -> { status, binds }
  const calls = [];
  const docker = async (args) => {
    calls.push(args.join(' '));
    const name = args[args.length - 1];
    if (args[0] === 'image') return { stdout: '', stderr: '' };
    if (args[0] === 'inspect' && String(args[2]).includes('.Mounts')) { if (!boxes[name]) throw new Error('No such object'); return { stdout: boxes[name].binds.map(b => `${b}\n`).join(''), stderr: '' }; }
    if (args[0] === 'inspect' && args.includes('{{.HostConfig.Init}}')) { if (!boxes[name]) throw new Error('No such object'); return { stdout: `${boxes[name].init}\n`, stderr: '' }; }
    if (args[0] === 'inspect') { if (!boxes[name]) throw new Error('No such object'); return { stdout: `${boxes[name].status}\n`, stderr: '' }; }
    if (args[0] === 'rm') {
      const n = args[args.length - 1];
      if (!args.includes('-f') && boxes[n] && (boxes[n].status === 'running' || boxes[n].status === 'paused')) throw new Error('You cannot remove a running container');
      delete boxes[n]; return { stdout: '', stderr: '' };
    }
    if (args[0] === 'create') { const binds = []; for (let i = 0; i < args.length; i++) if (args[i] === '-v' && args[i + 1].startsWith('/')) binds.push(args[i + 1].split(':')[0]); boxes[args[args.indexOf('--name') + 1]] = { status: 'created', binds, init: args.includes('--init') }; return { stdout: 'id\n', stderr: '' }; }
    if (args[0] === 'start') { boxes[name].status = 'running'; return { stdout: '', stderr: '' }; }
    return { stdout: '', stderr: '' };
  };
  const sb = createSandbox({ docker, wrapperDir: path.join(dir, 'w'), uid: 1000, gid: 1000, image: 'agent-hub-sandbox:test', log: () => {}, workspaceFor: ws, rootsFor: () => [] });
  const agent = { name: 'newname', box: 'eeeeeeeeeeee', model: 'claude-sdk/x' };
  fs.mkdirSync(ws(agent), { recursive: true });
  // a stopped box of this agent made for other folders (its Files folder appeared, or a removal failed)
  boxes['hub-agent-newname-eeeeeeeeeeee'] = { status: 'exited', binds: [path.join(dir, 'workspaces', 'oldname')] };
  assert.strictEqual(await sb.ensure(agent), 'hub-agent-newname-eeeeeeeeeeee');
  assert.deepStrictEqual(boxes['hub-agent-newname-eeeeeeeeeeee'], { status: 'running', binds: [ws(agent)], init: true }, 'made again with the new folders');
  assert.ok(calls.includes('rm hub-agent-newname-eeeeeeeeeeee'));
  // stopped with the right folders: simply started again, nothing made
  boxes['hub-agent-newname-eeeeeeeeeeee'].status = 'exited';
  const before = calls.length;
  await sb.ensure(agent);
  assert.deepStrictEqual(calls.slice(before).filter(c => /^(rm|create|start) /.test(c)), ['start hub-agent-newname-eeeeeeeeeeee']);
  // stopped with the right folders but made without an init process: made again
  boxes['hub-agent-newname-eeeeeeeeeeee'] = { status: 'exited', binds: [ws(agent)], init: false };
  const b2 = calls.length;
  await sb.ensure(agent);
  const after = calls.slice(b2).filter(c => /^(rm|create|start) /.test(c)).map(c => c.split(' ').slice(0, 2).join(' '));
  assert.deepStrictEqual(after, ['rm hub-agent-newname-eeeeeeeeeeee', 'create --name', 'start hub-agent-newname-eeeeeeeeeeee']);
  assert.deepStrictEqual(boxes['hub-agent-newname-eeeeeeeeeeee'], { status: 'running', binds: [ws(agent)], init: true });
  // a running box is never made again under a turn's feet
  boxes['hub-agent-newname-eeeeeeeeeeee'] = { status: 'running', binds: ['/somewhere/else'] };
  const n = calls.length;
  await sb.ensure(agent);
  assert.ok(!calls.slice(n).some(c => /^(rm|create) /.test(c)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('retire: when the box\'s own image was pruned after it was noted, the home folder is copied with the current one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-retire2-'));
  const into = path.join(dir, 'bundle'); fs.mkdirSync(into);
  fs.writeFileSync(path.join(into, '.box-image'), IMG);   // noted by an earlier try that removed the box
  const runs = [];
  let vol = true;
  const docker = async (args) => {
    if (args[0] === 'version') return { stdout: '27\n', stderr: '' };
    if (args[0] === 'container') throw Object.assign(new Error('No such container'), { stderr: 'Error: No such container: hub-agent-gone' });
    if (args[0] === 'volume' && args[1] === 'inspect') { if (!vol) throw Object.assign(new Error('no such volume'), { stderr: 'no such volume' }); return { stdout: 'v\n', stderr: '' }; }
    if (args[0] === 'volume' && args[1] === 'rm') { vol = false; return { stdout: '', stderr: '' }; }
    if (args[0] === 'run') {
      const from = args[args.indexOf('--entrypoint') + 2];
      runs.push(from);
      const host = args.find(x => x.endsWith(':/bundle')).slice(0, -':/bundle'.length);
      if (from === IMG) throw Object.assign(new Error('docker: Error response from daemon: No such image: ' + IMG), { stderr: 'Unable to find image' });
      fs.writeFileSync(path.join(host, path.basename(args[args.indexOf('-cf') + 1])), 'TAR');
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const sb = createSandbox({ docker, wrapperDir: path.join(dir, 'w'), uid: 1000, gid: 1000, image: 'agent-hub-sandbox:test', log: () => {} });
  assert.deepStrictEqual(await sb.retire({ name: 'gone' }, into, {}), { result: 'removed; home kept as box-home.tar' });
  assert.deepStrictEqual(runs, [IMG, 'agent-hub-sandbox:test']);
  assert.deepStrictEqual(fs.readdirSync(into), ['box-home.tar']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a box being removed is waited for: an agent renamed away and straight back never has its new box removed by the first clean-up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-pending-'));
  const ws = (a) => path.join(dir, 'workspaces', a.name);
  const order = [];
  let exists = true, releaseRm;
  const rmGate = new Promise(r => { releaseRm = r; });
  const docker = async (args) => {
    const name = args[args.length - 1];
    if (args[0] === 'image') return { stdout: '', stderr: '' };
    if (args[0] === 'stop') { order.push('stop'); return { stdout: '', stderr: '' }; }
    if (args[0] === 'rm') { await rmGate; exists = false; order.push('rm'); return { stdout: '', stderr: '' }; }
    if (args[0] === 'inspect') { if (!exists) throw new Error('No such object'); return { stdout: 'running\n', stderr: '' }; }
    if (args[0] === 'create') { order.push('create'); exists = true; return { stdout: 'id\n', stderr: '' }; }
    if (args[0] === 'start') { order.push('start'); return { stdout: '', stderr: '' }; }
    return { stdout: '', stderr: '' };
  };
  const sb = createSandbox({ docker, wrapperDir: path.join(dir, 'w'), uid: 1000, gid: 1000, image: 'agent-hub-sandbox:test', log: () => {}, workspaceFor: ws, rootsFor: () => [] });
  const alpha = { name: 'alpha', box: 'f0f0f0f0f0f0', model: 'claude-sdk/x' };
  fs.mkdirSync(ws(alpha), { recursive: true });
  const removal = sb.remove(alpha);            // alpha -> beta: the old box's clean-up, still on its way
  const turn = sb.ensure(alpha);               // beta -> alpha, and a turn at once
  await new Promise(r => setTimeout(r, 20));
  assert.deepStrictEqual(order, ['stop'], 'the turn waits while the removal is under way');
  releaseRm();
  await removal;
  assert.strictEqual(await turn, 'hub-agent-alpha-f0f0f0f0f0f0');
  assert.deepStrictEqual(order, ['stop', 'rm', 'create', 'start'], 'a fresh box, made after the removal, not removed by it');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('retire: a box of the same agent under an earlier name still holding the home folder goes too; a home already copied is not copied again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-retire3-'));
  const into = path.join(dir, 'bundle'); fs.mkdirSync(into);
  const calls = [];
  let volInUse = true, failRm = 1;
  const docker = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'version') return { stdout: '27\n', stderr: '' };
    if (args[0] === 'container') throw Object.assign(new Error('No such container'), { stderr: 'Error: No such container' });
    if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: 'v\n', stderr: '' };
    if (args[0] === 'ps') return { stdout: volInUse ? 'hub-agent-oldname-f1f1f1f1f1f1\n' : '', stderr: '' };
    if (args[0] === 'rm') { volInUse = false; return { stdout: '', stderr: '' }; }
    if (args[0] === 'volume' && args[1] === 'rm') { if (failRm-- > 0) throw Object.assign(new Error('daemon busy'), { stderr: 'Error response from daemon: try again' }); return { stdout: '', stderr: '' }; }
    if (args[0] === 'run') { const host = args.find(x => x.endsWith(':/bundle')).slice(0, -':/bundle'.length); fs.writeFileSync(path.join(host, path.basename(args[args.indexOf('-cf') + 1])), 'TAR'); return { stdout: '', stderr: '' }; }
    return { stdout: '', stderr: '' };
  };
  const sb = createSandbox({ docker, wrapperDir: path.join(dir, 'w'), uid: 1000, gid: 1000, image: 'agent-hub-sandbox:test', log: () => {} });
  const gone = { name: 'newname', box: 'f1f1f1f1f1f1' };
  await assert.rejects(sb.retire(gone, into, {}), /daemon busy/);
  assert.ok(calls.includes('rm -f hub-agent-oldname-f1f1f1f1f1f1'), 'the earlier-name box using the volume was removed');
  assert.deepStrictEqual(fs.readdirSync(into).sort(), ['.box-home-copied', 'box-home.tar']);
  assert.deepStrictEqual(await sb.retire(gone, into, {}), { result: 'removed; home kept as box-home.tar' });
  assert.strictEqual(calls.filter(c => c.startsWith('run ')).length, 1, 'copied once');
  assert.deepStrictEqual(fs.readdirSync(into), ['box-home.tar']);
  assert.ok(calls.indexOf('rm -f hub-agent-oldname-f1f1f1f1f1f1') < calls.findIndex(c => c.startsWith('run ')), 'the earlier-name box went before the copy');
  // a marker whose tar is no longer there counts for nothing: the home is copied again before the volume goes
  const into2 = path.join(dir, 'bundle2'); fs.mkdirSync(into2);
  fs.writeFileSync(path.join(into2, '.box-home-copied'), 'box-home.tar');
  failRm = 0;
  await sb.retire(gone, into2, {});
  assert.deepStrictEqual(fs.readdirSync(into2), ['box-home.tar']);
  fs.rmSync(dir, { recursive: true, force: true });
});
