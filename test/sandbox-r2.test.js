'use strict';
// Security R2, the sandbox side: the owner's Claude sign-in is never copied into an agent's box; old copies are removed
// (purgeCredentials on every box start, sweepCredentials at hub start); the policy protects the box's own sign-in folder.
// Every test uses a docker stand-in: nothing here reaches the real Docker or the install's data/.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sandboxMod = require('../lib/sandbox');
const { createSandbox } = sandboxMod;
const tp = require('../lib/tool-policy');
tp.setMemberProviders({ memberDefaults: () => ({}), ownerGrants: () => ({}) });

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const CRED = '/home/agent/.claude/.credentials.json';
const agent = { name: 'boxed', model: 'claude-sdk/claude-haiku-5-5', owner: 'member1' };

function rig(o = {}) {
  const calls = [], logs = [];
  const states = o.states || {};
  const volumes = new Set(o.volumes || []);
  const stale = new Set(o.staleVolumes || []);   // volumes that hold an old copy
  const docker = async (args) => {
    calls.push(args);
    const cmd = args[0];
    if (cmd === 'inspect') {
      const st = states[args[args.length - 1]]; if (!st) throw new Error('No such container');
      if (args.includes('{{.HostConfig.Init}}')) return { stdout: 'true\n', stderr: '' };
      if (String(args[2]).includes('.Mounts')) return { stdout: (o.binds ? o.binds() : []).map(b => `${b}\n`).join(''), stderr: '' };
      return { stdout: st + '\n', stderr: '' };
    }
    if (cmd === 'create') { states[args[args.indexOf('--name') + 1]] = 'created'; return { stdout: 'id\n', stderr: '' }; }
    if (cmd === 'start') { states[args[args.length - 1]] = 'running'; return { stdout: '', stderr: '' }; }
    if (cmd === 'rm') { delete states[args[args.length - 1]]; return { stdout: '', stderr: '' }; }
    if (cmd === 'exec' && args.includes('sh') && args.some(a => String(a).includes('.credentials.json'))) {
      if (o.purgeFails) throw Object.assign(new Error('exec failed'), { stderr: 'Error response from daemon: container is not running\nsecond line' });
      if (o.purgeStill) throw Object.assign(new Error('Command failed: docker exec'), { code: 3, stdout: 'still-present\n', stderr: '' });
      return { stdout: o.purgeFinds ? 'removed\n' : '', stderr: '' };
    }
    if (cmd === 'volume' && args[1] === 'inspect') {
      const v = args[args.length - 1];
      if (!volumes.has(v)) throw Object.assign(new Error(`Error response from daemon: get ${v}: no such volume`), { stderr: `Error: No such volume: ${v}` });
      if (o.inspectFails === v) throw Object.assign(new Error('daemon unavailable'), { stderr: 'daemon unavailable' });
      return { stdout: v + '\n', stderr: '' };
    }
    if (cmd === 'run') {
      const v = args[args.indexOf('-v') + 1].split(':')[0];
      if (o.runFails === v) throw Object.assign(new Error('run failed'), { stderr: 'docker: permission denied\nmore' });
      if (o.runStill === v) throw Object.assign(new Error('Command failed: docker run'), { code: 3, stdout: 'removed\nstill-present\n', stderr: '' });
      return { stdout: stale.has(v) ? 'removed\n' : '', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-r2-'));
  const sb = createSandbox({
    docker, uid: 1234, gid: 5678, image: 'agent-hub-sandbox:test', log: (m) => logs.push(m),
    isMemberOwned: (a) => !!(a && a.owner && a.owner !== 'admin1'),
    workspaceFor: (a) => path.join(dir, 'workspaces', a.name), rootsFor: () => [],
  });
  return { sb, calls, logs, states, dir };
}
const joined = (calls) => calls.map(c => c.join(' '));

test('no sign-in copy: the module has no prepare, wrapperPath, syncCredentials or credentials option, and a box is never given a .credentials.json', async () => {
  for (const n of ['prepare', 'wrapperPath', 'syncCredentials']) assert.strictEqual(rig().sb[n], undefined, `${n} is gone from the sandbox`);
  assert.strictEqual(sandboxMod.CLIENT_ENV_FORWARD, undefined);
  const src = read('lib', 'sandbox.js');
  assert.ok(!/\b(syncCredentials|wrapperPath|prepare|credentialsFile|CLIENT_ENV_FORWARD)\b/.test(src), 'no trace of them in the source');
  assert.ok(!/['"`]cp['"`]/.test(src), 'the module never runs docker cp');
  // behaviour: create, start, an already-running box, a stopped box, and a command, with a sign-in file present on the host
  const { sb, calls, states, dir } = rig();
  const fakeHome = path.join(dir, 'home'); fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.claude', '.credentials.json'), '{"tok":1}');
  await sb.ensure(agent);                                  // a new box
  await sb.ensure(agent);                                  // already running
  states['hub-agent-boxed'] = 'exited'; await sb.ensure(agent);   // a stopped box started again
  await sb.exec(agent, 'echo hi');
  for (const c of calls) {
    assert.notStrictEqual(c[0], 'cp', `no docker cp: ${c.join(' ')}`);
    assert.ok(!(c.includes('mkdir') && c.some(a => String(a).includes('.claude'))), `no mkdir of ~/.claude: ${c.join(' ')}`);
    assert.ok(!(c[0] === 'create' && c.some(a => /credentials|\.claude/.test(String(a)))), 'nothing of the sign-in is mounted');
  }
});

test('purgeCredentials: runs the test-and-remove with docker exec as the box user, and says whether it removed a copy', async () => {
  const none = rig({ states: { 'hub-agent-boxed': 'running' } });
  assert.strictEqual(await none.sb.purgeCredentials(agent), false);
  const call = none.calls.find(c => c[0] === 'exec');
  assert.deepStrictEqual(call.slice(0, 4), ['exec', 'hub-agent-boxed', 'sh', '-c']);
  assert.strictEqual(call[4], `if [ -e ${CRED} ] || [ -L ${CRED} ]; then rm -f ${CRED} && echo removed; fi; if [ -e ${CRED} ] || [ -L ${CRED} ]; then echo still-present; exit 3; fi`);
  assert.ok(!call.includes('-u') && !call.includes('--user'), 'as the box\'s own user');
  const found = rig({ states: { 'hub-agent-boxed': 'running' }, purgeFinds: true });
  assert.strictEqual(await found.sb.purgeCredentials(agent), true);
});

test('purgeCredentials script: removes, then checks again and exits 3 (still-present) while a copy remains', async () => {
  const r = rig({ states: { 'hub-agent-boxed': 'running' } });
  await r.sb.purgeCredentials(agent);
  const script = r.calls.find(c => c[0] === 'exec')[4];
  const rm = script.indexOf('rm -f'), recheck = script.indexOf('if', script.indexOf('fi;') + 1);
  assert.ok(rm >= 0 && recheck > rm, 'a second test comes after the rm');
  assert.ok(script.slice(recheck).includes(`[ -e ${CRED} ] || [ -L ${CRED} ]`), 'the re-check looks for the file or a link');
  assert.ok(/echo still-present; exit 3/.test(script.slice(recheck)), 'exit 3 with still-present');
  // run the script for real in a throwaway dir (a file, then a copy that cannot be removed: a directory with the name stays)
  const { spawnSync } = require('child_process');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-purge-'));
  const f = path.join(d, 'c.json'); const local = script.split(CRED).join(f);
  fs.writeFileSync(f, 'x');
  let o = spawnSync('sh', ['-c', local], { encoding: 'utf8' });
  assert.strictEqual(o.status, 0); assert.strictEqual(o.stdout.trim(), 'removed'); assert.ok(!fs.existsSync(f));
  fs.mkdirSync(path.join(f, 'sub'), { recursive: true });   // rm -f cannot remove a directory: the copy stays
  o = spawnSync('sh', ['-c', local], { encoding: 'utf8' });
  assert.strictEqual(o.status, 3, 'exit 3 while the path is still there'); assert.ok(/still-present/.test(o.stdout));
  fs.rmSync(path.join(f, 'sub'), { recursive: true }); fs.rmdirSync(f);
  o = spawnSync('sh', ['-c', local], { encoding: 'utf8' });
  assert.strictEqual(o.status, 0, 'nothing there: exit 0'); assert.strictEqual(o.stdout.trim(), '');
  fs.rmSync(d, { recursive: true, force: true });
});

test('ensure removes an old copy after a create, after a start every time, and for an already-running box once per process; a failure rejects ensure with ECREDPURGE and is retried', async () => {
  const purges = (calls) => calls.filter(c => c[0] === 'exec' && c.some(a => String(a).includes('.credentials.json'))).length;
  // a new box: purged
  const a = rig(); await a.sb.ensure(agent);
  assert.strictEqual(purges(a.calls), 1, 'purged after create + start');
  // already running: the next ensure of the same running box does not look again
  await a.sb.ensure(agent); await a.sb.ensure(agent);
  assert.strictEqual(purges(a.calls), 1, 'a running box is looked at once per process');
  // stopped, then started again: every time
  a.states['hub-agent-boxed'] = 'exited'; await a.sb.ensure(agent);
  assert.strictEqual(purges(a.calls), 2, 'purged after a start');
  // a box that was already running when the hub started: once, not twice
  const b = rig({ states: { 'hub-agent-boxed': 'running' } });
  await b.sb.ensure(agent); await b.sb.ensure(agent);
  assert.strictEqual(purges(b.calls), 1, 'an already-running box: once');
  // a failing purge: logged with the reason, ensure REJECTS (ECREDPURGE) so the turn's hands are withheld, and the next turn tries again
  const f = rig({ purgeFails: true });
  await assert.rejects(() => f.sb.ensure(agent), (e) => e.code === 'ECREDPURGE' && /could not be removed from hub-agent-boxed/.test(e.message));
  assert.ok(f.logs.includes('could not remove an old Claude sign-in copy from hub-agent-boxed: Error response from daemon: container is not running'), f.logs.join('|'));
  assert.strictEqual(purges(f.calls), 1);
  await assert.rejects(() => f.sb.ensure(agent), { code: 'ECREDPURGE' });
  assert.strictEqual(purges(f.calls), 2, 'tried again after a failure (the box was forgotten, even though it is running)');
  // a copy that is still there after rm (script exit 3, stdout still-present) is the same failure
  const s = rig({ purgeStill: true });
  await assert.rejects(() => s.sb.ensure(agent), { code: 'ECREDPURGE' });
  assert.ok(s.logs.includes('could not remove an old Claude sign-in copy from hub-agent-boxed: still-present'), s.logs.join('|'));
  await assert.rejects(() => s.sb.ensure(agent), { code: 'ECREDPURGE' });
  assert.strictEqual(purges(s.calls), 2);
  // and once the copy can go, the next ensure succeeds
  const ok = rig({ states: { 'hub-agent-boxed': 'running' } });
  assert.strictEqual(await ok.sb.ensure(agent), 'hub-agent-boxed');
});

test('sweepCredentials: only the named agents\' volumes, a missing volume skipped, the throwaway container is locked down, counts and the log line', async () => {
  const names = ['alpha', 'beta', 'gamma'];
  const r = rig({ volumes: ['hub-agent-alpha-home', 'hub-agent-gamma-home', 'hub-agent-other-install-home'], staleVolumes: ['hub-agent-gamma-home', 'hub-agent-other-install-home'] });
  const out = await r.sb.sweepCredentials(names);
  assert.deepStrictEqual(out, { checked: 2, removed: ['gamma'], failed: [] });
  const text = joined(r.calls);
  assert.deepStrictEqual(r.calls.filter(c => c[0] === 'volume').map(c => c[c.length - 1]), ['hub-agent-alpha-home', 'hub-agent-beta-home', 'hub-agent-gamma-home'], 'inspected only the named agents\' volumes');
  assert.ok(!text.some(t => t.includes('other-install')), 'never another install\'s volume');
  const runs = r.calls.filter(c => c[0] === 'run');
  assert.strictEqual(runs.length, 2, 'none for the missing volume');
  const g = runs.find(c => c.includes('hub-agent-gamma-home:/box-home'));
  assert.ok(g, 'volume mounted at /box-home');
  const has = (flag, val) => { const i = g.indexOf(flag); return i >= 0 && (val === undefined || g[i + 1] === val); };
  assert.ok(g.includes('--rm') && has('--network', 'none') && g.includes('--read-only') && has('--cap-drop', 'ALL') && has('--security-opt', 'no-new-privileges') && has('--user', '1234:5678') && has('--entrypoint', 'sh'), g.join(' '));
  assert.ok(g.includes('agent-hub-sandbox:test') && g[g.indexOf('-c') + 1].includes('/box-home/.claude/.credentials.json') && g[g.indexOf('-c') + 1].includes('.credentials.json.*'), 'the image and the test-and-remove, backups included');
  assert.ok(r.logs.includes('removed old Claude sign-in copies from 1 box(es): gamma'), r.logs.join('|'));
  // nothing found
  const clean = rig({ volumes: ['hub-agent-alpha-home'] });
  assert.deepStrictEqual(await clean.sb.sweepCredentials(['alpha']), { checked: 1, removed: [], failed: [] });
  assert.ok(clean.logs.includes('no old Claude sign-in copies in boxes'), clean.logs.join('|'));
  // no agents: nothing is run at all
  const empty = rig(); assert.deepStrictEqual(await empty.sb.sweepCredentials([]), { checked: 0, removed: [], failed: [] });
  assert.strictEqual(empty.calls.length, 0);
});

test('sweepCredentials: a failure is reported in failed[] and the other volumes are still swept; an agent with a box id is found by its own volume', async () => {
  const r = rig({ volumes: ['hub-agent-alpha-home', 'hub-agent-beta-home'], staleVolumes: ['hub-agent-beta-home'], runFails: 'hub-agent-alpha-home' });
  const out = await r.sb.sweepCredentials(['alpha', 'beta']);
  assert.deepStrictEqual(out.failed, [{ name: 'alpha', reason: 'docker: permission denied' }]);
  assert.deepStrictEqual(out.removed, ['beta']);
  assert.strictEqual(out.checked, 2);
  const d = rig({ inspectFails: 'hub-agent-alpha-home', volumes: ['hub-agent-alpha-home'] });
  const o2 = await d.sb.sweepCredentials(['alpha']);
  assert.strictEqual(o2.failed.length, 1, 'Docker not answering is a failure, not "no volume"');
  const id = 'a1b2c3d4e5f60718';
  const e = rig({ volumes: [`hub-agent-${id}-home`], staleVolumes: [`hub-agent-${id}-home`] });
  assert.deepStrictEqual((await e.sb.sweepCredentials([{ name: 'alpha', box: id }])).removed, ['alpha']);
});

test('sweepCredentials: a copy still present after rm (script exit 3) is a failure in failed[], not "clean" and not removed', async () => {
  const r = rig({ volumes: ['hub-agent-alpha-home', 'hub-agent-beta-home'], staleVolumes: ['hub-agent-beta-home'], runStill: 'hub-agent-alpha-home' });
  const out = await r.sb.sweepCredentials(['alpha', 'beta']);
  assert.strictEqual(out.failed.length, 1);
  assert.strictEqual(out.failed[0].name, 'alpha');
  assert.ok(/Command failed/.test(out.failed[0].reason), out.failed[0].reason);
  assert.deepStrictEqual(out.removed, ['beta'], 'the failed one is not listed as removed, even though stdout said removed');
  assert.ok(!r.logs.includes('no old Claude sign-in copies in boxes'));
  assert.ok(r.logs.some(l => /could not check 1 box home volume\(s\): alpha \(/.test(l)), r.logs.join('|'));
  const only = rig({ volumes: ['hub-agent-alpha-home'], runStill: 'hub-agent-alpha-home' });
  const o2 = await only.sb.sweepCredentials(['alpha']);
  assert.deepStrictEqual(o2.removed, []); assert.strictEqual(o2.failed.length, 1);
  assert.ok(only.logs.some(l => /could not check 1 box home volume/.test(l)), 'a failure is logged');
  // the script itself: re-check and exit 3, backups included
  const run = r.calls.find(c => c[0] === 'run'); const script = run[run.indexOf('-c') + 1];
  assert.ok(/left=1/.test(script) && /echo still-present; exit 3/.test(script), script);
});

test('removeOldWrappers: only data/sandbox/<name>.sh files of this user go; other files, folders and links stay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-wrap-'));
  fs.writeFileSync(path.join(dir, 'a.sh'), '#!/bin/sh'); fs.writeFileSync(path.join(dir, 'b.c.sh'), '#!/bin/sh');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep'); fs.mkdirSync(path.join(dir, 'sub.sh'));
  fs.symlinkSync(path.join(dir, 'notes.txt'), path.join(dir, 'link.sh'));
  assert.strictEqual(sandboxMod.removeOldWrappers(dir), 2);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['link.sh', 'notes.txt', 'sub.sh']);
  assert.strictEqual(sandboxMod.removeOldWrappers(path.join(dir, 'nope')), 0);
  assert.strictEqual(sandboxMod.OLD_WRAPPER_DIR, path.join(ROOT, 'data', 'sandbox'));
});

test('server.js start: sweepCredentials gets the agents of agents.json asynchronously, only when Docker and the image are there, and is never awaited by the start', () => {
  const srv = read('server.js');
  const at = srv.indexOf('sweepCredentials(');
  assert.ok(at > 0, 'the start sweeps the boxes');
  const block = srv.slice(srv.lastIndexOf('(async () => {', at), srv.indexOf('.catch(', at) + 80);
  assert.ok(/\(async \(\) => \{\s*\n\s*const sb = require\('\.\/lib\/sandbox'\)\.getSandbox\(\);\s*\n\s*if \(!\(await sb\.available\(\)\)\) return;\s*\n\s*await sb\.sweepCredentials\(await getAgents\(\)\);\s*\n\s*\}\)\(\)\.catch\(/.test(block), block);
  assert.ok(!/await\s*\(async \(\) => \{/.test(srv.slice(at - 400, at)), 'the IIFE is not awaited');
  assert.ok(!/(^|[^.\w])await\s+sb\.sweepCredentials|return\s+sb\.sweepCredentials/.test(srv.replace(/\(async \(\) => \{[\s\S]*?\}\)\(\)\.catch/, '')), 'nothing else in the start waits for it');
  assert.ok(srv.includes("require('./lib/sandbox').removeOldWrappers()"), 'the old wrapper scripts are removed');
});

test('tool-policy: a boxed agent cannot read or write /home/agent/.claude (or .codex) by path, ~ or $HOME; an unboxed agent\'s decisions are unchanged', () => {
  const boxed = { name: 'haiku', category: 'worker', sandbox: 'container' };
  const plain = { name: 'haiku', category: 'worker' };
  const cwd = path.join(tp.HUB_ROOT, 'workspaces', 'haiku');
  const d = (a, tool, input, extra = {}) => tp.decide({ agent: a, tool, input, cwd, ...extra });
  const reads = [
    ['Read', { file_path: CRED }], ['mcp__hub__Read', { file_path: CRED }], ['mcp__hub__Read', { file_path: '~/.claude/.credentials.json' }],
    ['mcp__hub__Read', { file_path: '$HOME/.claude/.credentials.json' }], ['mcp__hub__Glob', { path: '/home/agent/.codex', pattern: '*' }],
    ['Bash', { command: `cat ${CRED}` }], ['mcp__hub__Bash', { command: 'cat $HOME/.claude/.credentials.json' }],
    ['mcp__hub__Bash', { command: 'cat "${HOME}/.claude/.credentials.json"' }], ['mcp__hub__Bash', { command: 'ls ~/.claude' }],
    ['mcp__hub__Bash', { command: 'cat /home/agent/.codex/auth.json | head' }],
  ];
  for (const [tool, input] of reads) {
    const r = d(boxed, tool, input);
    assert.strictEqual(r.decision, 'deny', `${tool} ${JSON.stringify(input)}: ${r.decision} ${r.cls}`);
    assert.strictEqual(r.cls, 'admin', `${tool} ${JSON.stringify(input)}`);
  }
  const writes = [['mcp__hub__Write', { file_path: CRED, content: 'x' }], ['mcp__hub__Edit', { file_path: '$HOME/.claude/settings.json' }],
    ['mcp__hub__Bash', { command: 'cp /tmp/x /home/agent/.claude/.credentials.json' }], ['mcp__hub__Bash', { command: 'echo x > $HOME/.claude/settings.json' }]];
  for (const [tool, input] of writes) assert.strictEqual(d(boxed, tool, input).cls, 'admin', `${tool} ${JSON.stringify(input)}`);
  // an explicit isBoxed answer works the same, and a box-home path outside the sign-in folders is not made worse
  assert.strictEqual(d(plain, 'mcp__hub__Read', { file_path: CRED }, { isBoxed: () => true }).decision, 'deny');
  assert.notStrictEqual(d(boxed, 'mcp__hub__Read', { file_path: '/home/agent/notes.txt' }).cls, 'admin');
  // unboxed agents: the same calls are decided as before (these paths are nothing special on the host)
  for (const [tool, input] of [['Read', { file_path: CRED }], ['Bash', { command: `cat ${CRED}` }], ['Write', { file_path: CRED, content: 'x' }]]) {
    const r = d(plain, tool, input);
    assert.notStrictEqual(r.cls, 'admin', `unboxed ${tool}: ${r.cls}`);
  }
  assert.strictEqual(d(plain, 'Read', { file_path: CRED }).decision, 'allow');
  // the host's own ~/.claude stays admin for everybody
  assert.strictEqual(d(plain, 'Read', { file_path: path.join(os.homedir(), '.claude', '.credentials.json') }).cls, 'admin');
});

test('getSandbox tells the policy which agents are boxed (the registered provider)', () => {
  const seen = [];
  tp.setBoxedProvider((a) => { seen.push(a.name); return a.name === 'inbox'; });
  try {
    const cwd = path.join(tp.HUB_ROOT, 'workspaces', 'x');
    assert.strictEqual(tp.decide({ agent: { name: 'inbox', category: 'worker' }, tool: 'mcp__hub__Read', input: { file_path: CRED }, cwd }).cls, 'admin');
    assert.notStrictEqual(tp.decide({ agent: { name: 'outbox', category: 'worker' }, tool: 'mcp__hub__Read', input: { file_path: CRED }, cwd }).cls, 'admin');
    assert.deepStrictEqual(seen, ['inbox', 'outbox']);
  } finally { tp.setBoxedProvider(null); }
  assert.ok(read('lib', 'sandbox.js').includes('setBoxedProvider('), 'lib/sandbox registers it');
});
