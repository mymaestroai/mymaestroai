'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const toolPolicy = require('../lib/tool-policy');
const lb = require('../lib/lockbox');

const tmpRoot = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lockbox-idx-'));

/** A hub home and an install folder in temp folders, with a few files in <hubRoot>/data. */
function world() {
  const hubHome = tmpRoot();
  const hubRoot = tmpRoot();
  fs.mkdirSync(path.join(hubRoot, 'data', 'sub'), { recursive: true });
  for (const f of ['users.json', 'auth.db', 'wallet-keystore.json', 'notes.txt', path.join('sub', 'agent-key')]) fs.writeFileSync(path.join(hubRoot, 'data', f), 'x');
  for (const n of ['agent-a', 'agent-b', 'lead-a']) fs.mkdirSync(path.join(hubRoot, 'workspaces', n), { recursive: true });
  fs.mkdirSync(path.join(hubHome, 'share'), { recursive: true });
  return { hubHome, hubRoot, workspaces: ['agent-a', 'agent-b', 'lead-a'] };
}

/** policyFor's role and rules, with roots that do not include /tmp (the temp hub home lives there). */
function policyOf(agent, extraRoots = [], w) {
  const p = toolPolicy.policyFor(agent);
  return { ...p, roots: [path.join(w.hubRoot, 'workspaces', agent.name), path.join(w.hubHome, 'share'), ...extraRoots] };
}
const okProbe = () => ({ ok: true, reason: '' });
const badProbe = () => ({ ok: false, reason: 'no landlock' });
const settingOf = (v) => (k) => (k === 'lockboxDefault' ? v : undefined);
const base = (w, extra = {}) => ({ hubHome: w.hubHome, hubRoot: w.hubRoot, workspaces: w.workspaces, ...extra });

test('resolveMode: own value wins, otherwise the hub default, otherwise off', () => {
  const gs = settingOf('watch');
  assert.strictEqual(lb.resolveMode({ lockbox: 'enforce' }, { getSetting: gs }), 'enforce');
  assert.strictEqual(lb.resolveMode({ lockbox: 'off' }, { getSetting: settingOf('enforce') }), 'off');
  assert.strictEqual(lb.resolveMode({ lockbox: 'inherit' }, { getSetting: gs }), 'watch');
  assert.strictEqual(lb.resolveMode({ lockbox: 'bogus' }, { getSetting: gs }), 'watch');
  assert.strictEqual(lb.resolveMode({}, { getSetting: gs }), 'watch');
  assert.strictEqual(lb.resolveMode({}, { getSetting: settingOf('maybe') }), 'off');
  assert.strictEqual(lb.resolveMode({ lockbox: 'inherit' }, { getSetting: () => undefined }), 'off');
});

test('adminWriteRoots matches classifyPath; SENSITIVE_READ is absolute paths', () => {
  const roots = toolPolicy.adminWriteRoots();
  assert.ok(Array.isArray(roots) && roots.length >= 9);
  for (const r of roots) {
    assert.ok(path.isAbsolute(r));
    assert.strictEqual(toolPolicy.classifyPath(r, { roots: ['/'], agentName: 'x' }), 'admin', r);
    assert.strictEqual(toolPolicy.classifyPath(path.join(r, 'child'), { roots: ['/'], agentName: 'x' }), 'admin', r);
  }
  assert.ok(Array.isArray(toolPolicy.SENSITIVE_READ) && toolPolicy.SENSITIVE_READ.length > 0);
  assert.ok(toolPolicy.SENSITIVE_READ.every(p => path.isAbsolute(p)));
});

test('prepareAgentDirs: folders at 0700, bad names and links refused', () => {
  const w = world();
  const dirs = lb.prepareAgentDirs('agent-a', { hubHome: w.hubHome });
  assert.deepStrictEqual(dirs, lb.agentDirs('agent-a', { hubHome: w.hubHome }));
  for (const d of [path.join(w.hubHome, 'lockbox'), dirs.dir, dirs.tmp, dirs.npm]) assert.strictEqual(fs.statSync(d).mode & 0o777, 0o700, d);
  lb.prepareAgentDirs('agent-a', { hubHome: w.hubHome });   // again: fine
  for (const bad of ['../x', 'Agent', '', 'a/b', 'a b']) assert.throws(() => lb.prepareAgentDirs(bad, { hubHome: w.hubHome }), /valid agent name/);
  const w2 = world();
  const elsewhere = tmpRoot();
  fs.symlinkSync(elsewhere, path.join(w2.hubHome, 'lockbox'));
  assert.throws(() => lb.prepareAgentDirs('agent-a', { hubHome: w2.hubHome }), /link/);
  assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
});

test('buildProfile for a worker', () => {
  const w = world();
  const agent = { name: 'agent-a', lockboxEnv: ['MY_TOKEN', 'bad name', '1X', 'GOOD_2'] };
  const outsideRoot = path.join(toolPolicy.HUB_ROOT, 'data', 'inner');
  const policy = policyOf(agent, [outsideRoot], w);
  const dirs = lb.agentDirs('agent-a', { hubHome: w.hubHome });
  lb.prepareAgentDirs('agent-a', { hubHome: w.hubHome });   // a root that does not exist is not granted
  const p = lb.buildProfile({ agent, policy, mode: 'enforce', tool: 'Bash', command: 'echo   hi\nthere', ...base(w) });
  assert.strictEqual(p.v, 1);
  assert.strictEqual(p.mode, 'enforce');
  assert.strictEqual(p.agent, 'agent-a');
  assert.strictEqual(p.tool, 'Bash');
  for (const r of policy.roots.filter(r => r !== outsideRoot)) assert.ok(p.writes.includes(r), r);
  assert.ok(p.writes.includes(dirs.dir));
  assert.ok(!p.writes.includes(outsideRoot), 'a root inside data/ is dropped');
  for (const r of toolPolicy.adminWriteRoots()) assert.ok(p.writeHoles.includes(path.resolve(r)), r);
  assert.ok(p.writeHoles.includes(path.join(w.hubRoot, 'workspaces', 'agent-b')));
  assert.ok(!p.writeHoles.includes(path.join(w.hubRoot, 'workspaces', 'agent-a')));
  assert.ok(p.writeHoles.includes(path.join(w.hubHome, 'lockbox')));
  assert.ok(p.readHoles.includes(path.join(toolPolicy.HUB_ROOT, 'data', 'users.json')));
  assert.ok(p.readHoles.includes(path.join(w.hubRoot, 'data', 'wallet-keystore.json')));
  assert.ok(p.readHoles.includes(path.join(w.hubRoot, 'data', 'sub')), 'a sub folder of data/ is hidden whole (what is inside it is covered by it)');
  assert.ok(p.readHoles.includes(path.join(w.hubRoot, 'data', 'notes.txt')), 'every entry of data/ is a read hole');
  assert.ok(p.readHoles.includes(path.join(w.hubHome, 'lockbox')));
  assert.deepStrictEqual(p.env.keep, [...lb.ENV_KEEP, 'MY_TOKEN', 'GOOD_2']);
  assert.deepStrictEqual(p.env.set, { TMPDIR: dirs.tmp, npm_config_cache: dirs.npm });
  assert.deepStrictEqual(p.devWrites, ['/dev/null', '/dev/zero', '/dev/full', '/dev/tty', '/dev/ptmx', '/dev/pts', '/dev/shm']);
  assert.strictEqual(p.cwdFile, null);
  assert.strictEqual(p.blockUnixSockets, true);
  assert.strictEqual(p.blockIoUring, true);
  assert.deepStrictEqual(p.log, { path: path.join(w.hubRoot, 'data', 'lockbox', 'watch.jsonl'), max: 50 });
  assert.strictEqual(p.label, 'echo hi there');
  assert.deepStrictEqual(p.writes, [...p.writes].sort());
  assert.strictEqual(lb.buildProfile({ agent, policy, mode: 'watch', tool: 'run_job', command: 'x'.repeat(500), ...base(w) }).label.length, 300);
});

test('buildProfile keeps the same base names as the hub\'s other spawns, and the names an admin granted with envKeep', () => {
  const childEnv = require('../lib/child-env');
  assert.deepStrictEqual(lb.ENV_KEEP, childEnv.BASE_KEEP, 'one base list for the box and the allow-listed environment');
  assert.ok(lb.ENV_KEEP.includes('PORT'));
  const w = world();
  const agent = { name: 'agent-a', envKeep: ['GH_TOKEN', 'MY_SETTING'], lockboxEnv: ['OTHER_NAME'] };
  lb.prepareAgentDirs('agent-a', { hubHome: w.hubHome });
  const p = lb.buildProfile({ agent, policy: policyOf(agent, [], w), mode: 'enforce', tool: 'Bash', command: 'x', ...base(w) });
  for (const n of ['GH_TOKEN', 'MY_SETTING', 'OTHER_NAME', 'PORT', 'PATH']) assert.ok(p.env.keep.includes(n), n);
  // A malformed envKeep (as child-env would refuse it) adds nothing.
  const q = lb.buildProfile({ agent: { name: 'agent-a', envKeep: 'GH_TOKEN' }, policy: policyOf(agent, [], w), mode: 'enforce', tool: 'Bash', command: 'x', ...base(w) });
  assert.deepStrictEqual(q.env.keep, lb.ENV_KEEP);
});

test('a root that contains the lockbox folders (an agent granted the whole hub home) builds a box laid out around them', () => {
  const w = world();
  const agent = { name: 'agent-a' };
  lb.prepareAgentDirs('agent-a', { hubHome: w.hubHome });
  lb.prepareAgentDirs('agent-b', { hubHome: w.hubHome });
  const p = lb.buildProfile({ agent, policy: policyOf(agent, [w.hubHome], w), mode: 'enforce', tool: 'Bash', command: 'x', ...base(w) });
  const lockboxDir = path.join(w.hubHome, 'lockbox');
  assert.ok(p.writes.includes(fs.realpathSync(w.hubHome)), 'the hub home root is granted');
  assert.ok(p.writes.includes(path.join(lockboxDir, 'agent-a')), 'its own folder too');
  assert.ok(p.writeHoles.includes(lockboxDir) && p.readHoles.includes(lockboxDir), 'other agents\' folders are holes inside it');
  const q = lb.buildProfile({ agent, policy: policyOf(agent, [lockboxDir], w), mode: 'enforce', tool: 'Bash', command: 'x', ...base(w) });
  assert.ok(!q.writes.includes(lockboxDir), 'a root inside the lockbox folders is not granted');
});

test('a root whose real path lands inside a hole is not granted (a shared parent bent elsewhere)', () => {
  const w = world();
  const agent = { name: 'agent-a' };
  fs.mkdirSync(path.join(w.hubRoot, 'data', 'ws'));
  const team = tmpRoot();
  fs.symlinkSync(path.join(w.hubRoot, 'data'), path.join(team, 'a'));
  const root = path.join(team, 'a', 'ws');
  const p = lb.buildProfile({ agent, policy: policyOf(agent, [root], w), mode: 'enforce', tool: 'Bash', command: 'x', ...base(w) });
  assert.ok(!p.writes.some(x => x.startsWith(path.join(w.hubRoot, 'data'))), JSON.stringify(p.writes));
  assert.ok(p.skipped.includes(root));
});

test('readAllow: only the agent\'s own Claude sessions\' tool-results, none without a session, none for the lead', () => {
  const w = world();
  const home = tmpRoot();
  const worker = { name: 'agent-a' };
  const s1 = '0f8c2a1e-1111-4abc-9def-000000000001';
  const p = lb.buildProfile({ agent: worker, policy: policyOf(worker, [], w), mode: 'enforce', tool: 'Bash', command: 'x', home, sessions: [s1, '../x', 'bad id'], ...base(w) });
  assert.deepStrictEqual(p.readAllow, [path.join(home, '.claude', 'projects', '*', s1, 'tool-results')], 'exactly its own session, bad ids dropped, no wildcard over sessions');
  const none = lb.buildProfile({ agent: worker, policy: policyOf(worker, [], w), mode: 'enforce', tool: 'Bash', command: 'x', home, ...base(w) });
  assert.deepStrictEqual(none.readAllow, []);
  const lead = { name: 'lead-a', lead: true, category: 'primary' };
  const q = lb.buildProfile({ agent: lead, policy: toolPolicy.policyFor(lead), mode: 'enforce', tool: 'Bash', command: 'x', home, sessions: [s1], ...base(w) });
  assert.deepStrictEqual(q.readAllow, []);
});

test('noteSession keeps an agent\'s three newest valid sessions for a day', () => {
  lb._resetSessions();
  const ids = ['a1b2c3d4-0000-0000-0000-000000000001', 'a1b2c3d4-0000-0000-0000-000000000002', 'a1b2c3d4-0000-0000-0000-000000000003', 'a1b2c3d4-0000-0000-0000-000000000004'];
  ids.forEach((id, i) => lb.noteSession('agent-a', id, { now: 1000 + i }));
  lb.noteSession('agent-a', '../../etc', { now: 2000 });
  assert.deepStrictEqual(lb.sessionsFor('agent-a', { now: 3000 }), [ids[3], ids[2], ids[1]]);
  assert.deepStrictEqual(lb.sessionsFor('agent-b', { now: 3000 }), []);
  assert.deepStrictEqual(lb.sessionsFor('agent-a', { now: 1000 + 25 * 3600 * 1000 }), []);
  lb._resetSessions();
});

test('buildProfile for the lead: hubHome and /tmp, no holes, no env', () => {
  const w = world();
  const agent = { name: 'lead-a', lead: true };
  const policy = toolPolicy.policyFor(agent);
  assert.strictEqual(policy.role, 'lead');
  const p = lb.buildProfile({ agent, policy, mode: 'watch', tool: 'Bash', command: 'ls', widen: { writes: ['/var/extra'], reads: [] }, ...base(w) });
  assert.ok(p.writes.includes(w.hubHome));
  assert.ok(p.writes.includes('/tmp'));
  assert.ok(p.writes.includes('/var/extra'));
  assert.deepStrictEqual(p.writeHoles, []);
  assert.deepStrictEqual(p.readHoles, []);
  assert.strictEqual(p.env, null);
});

test('a head with admin allow has no read holes; with ask it has', () => {
  const w = world();
  const open = { name: 'agent-a', category: 'primary', policy: { overrides: { admin: 'allow' } } };
  const ask = { name: 'agent-b', category: 'primary' };
  assert.strictEqual(toolPolicy.policyFor(open).rules.admin, 'allow');
  assert.strictEqual(lb.rolesWithHoles(toolPolicy.policyFor(open)), false);
  assert.strictEqual(lb.rolesWithHoles(toolPolicy.policyFor(ask)), true);
  const a = lb.buildProfile({ agent: open, policy: policyOf(open, [], w), mode: 'enforce', tool: 'Bash', command: 'x', ...base(w) });
  const b = lb.buildProfile({ agent: ask, policy: policyOf(ask, [], w), mode: 'enforce', tool: 'Bash', command: 'x', ...base(w) });
  assert.deepStrictEqual(a.readHoles, []);
  assert.ok(b.readHoles.length > 0);
  assert.ok(a.writeHoles.length > 0, 'write holes stay');
});

function decideArgs(w, agent, extra = {}) {
  return { agent, tool: 'Bash', command: 'echo hi', getSetting: settingOf('enforce'), probe: okProbe, policy: policyOf(agent, [], w), ...base(w), ...extra };
}

test('widen: an approval adds a write path and lifts a read hole, once, for 15 minutes', () => {
  lb._resetApprovals();
  const w = world();
  const agent = { name: 'agent-a' };
  const readOk = path.join(w.hubRoot, 'data', 'wallet-keystore.json');
  const t0 = 1_700_000_000_000;
  const extraW = fs.realpathSync(tmpRoot());   // a widened path that is missing is not granted, so it must exist
  lb.noteApproval({ agent: 'agent-a', command: 'echo hi', writes: [extraW, 'relative/path'], reads: [readOk], now: t0 });
  const first = lb.decide(decideArgs(w, agent, { now: t0 + 1000 }));
  assert.ok(first.profile);
  assert.ok(first.profile.writes.includes(extraW));
  assert.ok(!first.profile.writes.includes(path.resolve('relative/path')));
  assert.ok(!first.profile.readHoles.includes(readOk));
  const second = lb.decide(decideArgs(w, agent, { now: t0 + 2000 }));
  assert.ok(!second.profile.writes.includes(extraW));
  assert.ok(second.profile.readHoles.includes(readOk));
  // expiry
  lb.noteApproval({ agent: 'agent-a', command: 'echo hi', writes: [extraW], now: t0 });
  const late = lb.decide(decideArgs(w, agent, { now: t0 + 15 * 60 * 1000 + 1 }));
  assert.ok(!late.profile.writes.includes(extraW));
  // another agent or command does not take it
  lb.noteApproval({ agent: 'agent-a', command: 'echo hi', writes: [extraW], now: t0 });
  assert.deepStrictEqual(lb.takeApproval('agent-b', 'echo hi', { now: t0 }), { writes: [], reads: [] });
  assert.deepStrictEqual(lb.takeApproval('agent-a', 'echo other', { now: t0 }), { writes: [], reads: [] });
  assert.deepStrictEqual(lb.takeApproval('agent-a', 'echo hi', { now: t0 + 1 }).writes, [extraW]);
});

test('decide: off and sandboxed run today\'s code', () => {
  const w = world();
  const agent = { name: 'agent-a' };
  assert.deepStrictEqual(lb.decide(decideArgs(w, agent, { getSetting: settingOf('off') })), { mode: 'off' });
  assert.deepStrictEqual(lb.decide(decideArgs(w, agent, { getSetting: () => undefined })), { mode: 'off' });
  assert.deepStrictEqual(lb.decide(decideArgs(w, agent, { sandboxed: true })), { mode: 'off' });
  assert.deepStrictEqual(lb.decide(decideArgs(w, { name: 'agent-a', lockbox: 'off' })), { mode: 'off' });
});

test('decide: the lead with sudo is unconfined and logged', () => {
  const w = world();
  const agent = { name: 'lead-a', lead: true };
  const args = { agent, tool: 'Bash', command: 'sudo ls', getSetting: settingOf('watch'), probe: okProbe, sudo: true, now: 1_700_000_000_000, ...base(w) };
  assert.deepStrictEqual(lb.decide(args), { mode: 'watch', unconfined: 'sudo' });
  const lines = lb.readLog({ hubRoot: w.hubRoot });
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].rule, 'sudo-unconfined');
  assert.strictEqual(lines[0].agent, 'lead-a');
  assert.strictEqual(lines[0].cmd, 'sudo ls');
  assert.strictEqual(lines[0].op, 'run');
  assert.ok(lines[0].ts);
  // without sudo the lead is boxed
  assert.ok(lb.decide({ ...args, sudo: false }).profile);
});

test('decide: the host cannot box', () => {
  lb._resetProbe();
  const w = world();
  const agent = { name: 'agent-a' };
  const r = lb.decide(decideArgs(w, agent, { probe: badProbe }));
  assert.deepStrictEqual(r, { mode: 'enforce', refuse: 'The command lockbox is set to enforce for this agent, but it cannot run on this computer (no landlock), so the command was not run.' });
  assert.strictEqual(lb.readLog({ hubRoot: w.hubRoot }).length, 0);
  const t0 = 1_700_000_000_000;
  const watch = (now) => lb.decide(decideArgs(w, agent, { probe: badProbe, getSetting: settingOf('watch'), now }));
  assert.deepStrictEqual(watch(t0), { mode: 'watch', plain: true });
  assert.deepStrictEqual(watch(t0 + 60_000), { mode: 'watch', plain: true });
  let lines = lb.readLog({ hubRoot: w.hubRoot });
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0].rule, 'watch-unavailable');
  assert.strictEqual(lines[0].path, 'no landlock');
  watch(t0 + 10 * 60_000 + 1);
  lines = lb.readLog({ hubRoot: w.hubRoot });
  assert.strictEqual(lines.length, 2);
});

test('decide: a symlinked agent folder is refused (enforce) or run plain (watch)', () => {
  lb._resetProbe();
  const w = world();
  const elsewhere = tmpRoot();
  fs.mkdirSync(path.join(w.hubHome, 'lockbox'), { mode: 0o700 });
  fs.symlinkSync(elsewhere, path.join(w.hubHome, 'lockbox', 'agent-a'));
  const agent = { name: 'agent-a' };
  const r = lb.decide(decideArgs(w, agent));
  assert.strictEqual(r.mode, 'enforce');
  assert.match(r.refuse, /^The command lockbox could not prepare this agent's box \(.*link.*\), so the command was not run\.$/);
  const watch = lb.decide(decideArgs(w, agent, { getSetting: settingOf('watch'), now: 5 }));
  assert.deepStrictEqual(watch, { mode: 'watch', plain: true });
  assert.strictEqual(lb.readLog({ hubRoot: w.hubRoot })[0].rule, 'watch-unavailable');
  assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
});

test('decide: a boxed worker gets a profile and its folders', () => {
  const w = world();
  const r = lb.decide(decideArgs(w, { name: 'agent-a' }));
  assert.strictEqual(r.mode, 'enforce');
  assert.strictEqual(r.profile.mode, 'enforce');
  assert.ok(fs.statSync(path.join(w.hubHome, 'lockbox', 'agent-a', 'tmp')).isDirectory());
});

test('probe: not linux, helper output, errors, cache', () => {
  lb._resetProbe();
  assert.deepStrictEqual(lb.probe({ platform: 'darwin' }), { ok: false, reason: 'not available on this computer' });
  let calls = 0;
  let seen;
  const exec = (file, args, opts) => { calls++; seen = { file, args, opts }; return JSON.stringify({ ok: true, landlockAbi: 4 }) + '\n'; };
  assert.deepStrictEqual(lb.probe({ platform: 'linux', execFileSync: exec, now: 1000 }), { ok: true, landlockAbi: 4 });
  assert.strictEqual(seen.file, '/usr/bin/python3');
  assert.deepStrictEqual(seen.args, ['-I', '-S', lb.HELPER, '--probe']);
  assert.strictEqual(seen.opts.timeout, 5000);
  assert.strictEqual(seen.opts.encoding, 'utf8');
  lb.probe({ platform: 'linux', execFileSync: exec, now: 1000 + 9 * 60_000 });
  assert.strictEqual(calls, 1);
  lb.probe({ platform: 'linux', execFileSync: exec, now: 1000 + 10 * 60_000 + 1 });
  assert.strictEqual(calls, 2);
  lb._resetProbe();
  const bad = lb.probe({ platform: 'linux', execFileSync: () => { throw new Error('boom'); } });
  assert.deepStrictEqual(bad, { ok: false, reason: 'the lockbox helper could not run: boom' });
  lb._resetProbe();
  assert.strictEqual(lb.probe({ platform: 'linux', execFileSync: () => 'not json' }).ok, false);
  lb._resetProbe();
});

const fakeProfile = (extra = {}) => ({ v: 1, mode: 'enforce', agent: 'agent-a', tool: 'Bash', writes: ['/tmp/x'], writeHoles: [], readHoles: [], devWrites: lb.DEV_WRITES, env: null, cwdFile: null, blockUnixSockets: true, blockIoUring: true, log: { path: '/tmp/l', max: 50 }, label: 'it\'s', ...extra });
const decode = (b) => JSON.parse(Buffer.from(b, 'base64').toString('utf8'));

test('shQuote round-trips through bash', () => {
  const samples = ['plain', "it's", 'a "b" $HOME `id` $(id)', 'line1\nline2\n', "''", '', '\\n \\\\', "'; echo nope; '", 'tab\there', 'ünï'];
  for (const s of samples) {
    const r = spawnSync('/bin/bash', ['-c', 'printf %s ' + lb.shQuote(s)], { encoding: 'utf8' });
    assert.strictEqual(r.stdout, s, JSON.stringify(s));
  }
});

test('argvFor and jobLine carry the profile as base64', () => {
  const profile = fakeProfile();
  const a = lb.argvFor(profile, ['bash', '-c', 'echo hi']);
  assert.strictEqual(a.file, '/usr/bin/python3');
  assert.deepStrictEqual(a.args.slice(0, 4), ['-I', '-S', lb.HELPER, '--profile-b64']);
  assert.deepStrictEqual(decode(a.args[4]), profile);
  assert.deepStrictEqual(a.args.slice(5), ['--', 'bash', '-c', 'echo hi']);
  const line = lb.jobLine(profile);
  assert.ok(line.startsWith("'/usr/bin/python3' -I -S '" + lb.HELPER + "' --profile-b64 '"));
  assert.ok(line.endsWith(` -- bash "$D/job.sh"`));
  assert.deepStrictEqual(decode(/--profile-b64 '([^']+)'/.exec(line)[1]), profile);
});

test('clientCommand: boxed command that keeps the working folder', () => {
  const command = "echo 'it'\"'\"'s' $(pwd) `id`\ncd sub";
  const text = lb.clientCommand(fakeProfile(), command);
  const lines = text.split('\n');
  const cwdFile = /\/tmp\/lockbox-cwd-[0-9a-f]{24}/.exec(text)[0];
  assert.ok(text.includes("'" + cwdFile + "'"));
  const profile = decode(/--profile-b64 '([^']+)'/.exec(text)[1]);
  assert.strictEqual(profile.cwdFile, cwdFile);
  assert.strictEqual(fakeProfile().cwdFile, null);
  const inner = command + '\n' + '__lb_rc=$?; pwd -P > "$LOCKBOX_CWD_FILE" 2>/dev/null; exit $__lb_rc';
  assert.ok(text.includes(' -- bash -c ' + lb.shQuote(inner)));
  assert.ok(text.startsWith("'/usr/bin/python3' -I -S '" + lb.HELPER + "' --profile-b64 '"));
  assert.ok(lines[lines.length - 1].startsWith('__lb_rc=$?; __lb_d=$(cat \'' + cwdFile + '\' 2>/dev/null); rm -f \'' + cwdFile + '\'; if [ -n "$__lb_d" ]'));
  assert.ok(lines[lines.length - 1].endsWith('(exit $__lb_rc)'));
  // the command's own single quotes never appear unescaped outside shQuote(inner)
  const outside = text.replace(lb.shQuote(inner), '');
  assert.ok(!outside.includes('$(pwd)'));
  assert.strictEqual(spawnSync('/bin/bash', ['-n', '-c', text]).status, 0, 'syntactically valid shell');
  assert.notStrictEqual(lb.clientCommand(fakeProfile(), 'x'), lb.clientCommand(fakeProfile(), 'x'), 'a fresh cwd file each time');
});

test('log: newest first, agent filter, limit, corrupt lines skipped', () => {
  const w = world();
  assert.deepStrictEqual(lb.readLog({ hubRoot: w.hubRoot }), []);
  const put = (agent, n) => lb.appendLog({ ts: 't' + n, agent, tool: 'Bash', mode: 'watch', cmd: 'c' + n, op: 'run', path: '', rule: 'r' }, { hubRoot: w.hubRoot });
  put('agent-a', 1); put('agent-b', 2);
  fs.appendFileSync(path.join(w.hubRoot, 'data', 'lockbox', 'watch.jsonl'), '{not json\n');
  put('agent-a', 3); put('agent-b', 4);
  assert.deepStrictEqual(lb.readLog({ hubRoot: w.hubRoot }).map(e => e.cmd), ['c4', 'c3', 'c2', 'c1']);
  assert.deepStrictEqual(lb.readLog({ hubRoot: w.hubRoot, agent: 'agent-a' }).map(e => e.cmd), ['c3', 'c1']);
  assert.deepStrictEqual(lb.readLog({ hubRoot: w.hubRoot, limit: 2 }).map(e => e.cmd), ['c4', 'c3']);
  const file = path.join(w.hubRoot, 'data', 'lockbox', 'watch.jsonl');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test('log: only the last MiB is read', () => {
  const w = world();
  const file = path.join(w.hubRoot, 'data', 'lockbox', 'watch.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const filler = JSON.stringify({ agent: 'old', pad: 'y'.repeat(1000) }) + '\n';
  fs.writeFileSync(file, filler.repeat(1200) + JSON.stringify({ agent: 'new' }) + '\n');
  const got = lb.readLog({ hubRoot: w.hubRoot, limit: 500 });
  assert.strictEqual(got[0].agent, 'new');
  assert.ok(got.length <= 500);
  assert.ok(got.every(e => e.agent === 'new' || e.agent === 'old'));
});

test('statusFor: coverage values', () => {
  const agents = [
    { name: 'agent-a' },
    { name: 'agent-b', lockbox: 'enforce' },
    { name: 'agent-c', lockbox: 'weird' },
    { name: 'agent-d', model: 'codex-cli/x' },
    { name: 'agent-e', model: 'codex-cli/x' },
  ];
  const mk = (probe) => lb.statusFor({ agents, getSetting: settingOf('watch'), probe, sandboxedOf: a => a.name === 'agent-b', handsOf: a => (a.name === 'agent-d' ? 'client' : 'hub') });
  const ok = mk(okProbe);
  assert.strictEqual(ok.default, 'watch');
  assert.deepStrictEqual(ok.host, { ok: true, reason: '' });
  assert.deepStrictEqual(ok.agents.map(a => a.coverage), ['covered', 'container', 'covered', 'codex-client', 'covered']);
  assert.deepStrictEqual(ok.agents.map(a => a.setting), ['inherit', 'enforce', 'inherit', 'inherit', 'inherit']);
  assert.deepStrictEqual(ok.agents.map(a => a.mode), ['watch', 'enforce', 'watch', 'watch', 'watch']);
  assert.deepStrictEqual(mk(badProbe).agents.map(a => a.coverage), ['unavailable', 'container', 'unavailable', 'codex-client', 'unavailable']);
  assert.strictEqual(lb.statusFor({ agents: [], getSetting: settingOf('nope'), probe: okProbe }).default, 'off');
});

test('read holes: every entry of data/ but jobs/, the marker, and .env files', () => {
  const agent = { name: 'agent-a', category: 'worker' };
  const w = world();
  const jobs = path.join(w.hubRoot, 'data', 'jobs');
  fs.mkdirSync(jobs);
  for (let i = 0; i < 5100; i++) fs.writeFileSync(path.join(jobs, 'j' + i), '');   // a crowded jobs folder no longer matters
  fs.writeFileSync(path.join(w.hubRoot, '.env.local'), 'x');
  const p = lb.buildProfile({ agent, policy: policyOf(agent, [], w), mode: 'enforce', tool: 'Bash', command: 'ls', ...base(w) });
  const d = (...n) => path.join(w.hubRoot, 'data', ...n);
  for (const n of ['users.json', 'auth.db', 'wallet-keystore.json', 'notes.txt', 'sub']) assert.ok(p.readHoles.includes(d(n)), n);
  assert.ok(!p.readHoles.includes(jobs), 'jobs/ is not a hole');
  assert.ok(!p.readHoles.some(h => h.startsWith(jobs + path.sep)), 'nothing inside jobs/ is listed');
  assert.ok(p.readHoles.includes(d('.lockbox-hidden')), 'the marker keeps later entries hidden');
  assert.ok(p.readHoles.includes(path.join(w.hubRoot, '.env.local')), '.env files of the install');
  assert.ok(!p.readHoles.includes(d()), 'data/ itself is not listed when it can be read');
});

/** A hub root whose workspace for agent-a is a link to another temp folder. */
function linkedWorld() {
  const w = world();
  const hubRoot = tmpRoot();
  const target = tmpRoot();
  fs.mkdirSync(path.join(hubRoot, 'workspaces'));
  fs.symlinkSync(target, path.join(hubRoot, 'workspaces', 'agent-a'));
  return { ...w, hubRoot, target, ws: path.join(hubRoot, 'workspaces', 'agent-a') };
}

test('buildProfile: a workspace root that is a link gets no write rule and is listed in skipped', () => {
  const agent = { name: 'agent-a', category: 'worker' };
  const w = linkedWorld();
  lb.prepareAgentDirs('agent-a', { hubHome: w.hubHome });
  const p = lb.buildProfile({ agent, policy: policyOf(agent, [], w), mode: 'enforce', tool: 'Bash', command: 'ls', ...base(w) });
  assert.ok(!p.writes.includes(w.ws), 'the link itself is not granted');
  assert.ok(!p.writes.includes(w.target), 'neither is where it points');
  assert.deepStrictEqual(p.skipped, [w.ws]);
  assert.ok(p.writes.includes(path.join(w.hubHome, 'share')), 'the other roots stay');
  assert.ok(p.writes.includes(lb.agentDirs('agent-a', { hubHome: w.hubHome }).dir));
});

test('buildProfile: a root under the share root whose parent folder became a link is skipped; a missing root is neither granted nor listed', () => {
  const agent = { name: 'agent-a', category: 'worker' };
  const w = world();
  lb.prepareAgentDirs('agent-a', { hubHome: w.hubHome });
  const share = path.join(w.hubHome, 'share');
  const elsewhere = tmpRoot();
  fs.mkdirSync(path.join(elsewhere, 'proj'));
  fs.symlinkSync(elsewhere, path.join(share, 'bent'));
  const bentRoot = path.join(share, 'bent', 'proj');
  const missing = path.join(share, 'not-there');
  const p = lb.buildProfile({ agent, policy: policyOf(agent, [bentRoot, missing], w), mode: 'enforce', tool: 'Bash', command: 'ls', ...base(w) });
  assert.ok(!p.writes.includes(bentRoot));
  assert.ok(!p.writes.includes(path.join(elsewhere, 'proj')));
  assert.deepStrictEqual(p.skipped, [bentRoot]);
  assert.ok(!p.writes.includes(missing));
  assert.ok(!p.skipped.includes(missing));
  assert.ok(p.writes.includes(share), 'the share root itself is fine');
  // a profile for a lead and one with nothing bent have an empty skipped list
  const ok = lb.buildProfile({ agent, policy: policyOf(agent, [], w), mode: 'enforce', tool: 'Bash', command: 'ls', ...base(w) });
  assert.deepStrictEqual(ok.skipped, []);
});

test('decide: a skipped root is logged as root-is-link (watch)', () => {
  const agent = { name: 'agent-a', category: 'worker' };
  const w = linkedWorld();
  const r = lb.decide(decideArgs(w, agent, { getSetting: settingOf('watch'), now: 1_700_000_000_000 }));
  assert.ok(r.profile);
  assert.deepStrictEqual(r.profile.skipped, [w.ws]);
  const lines = lb.readLog({ hubRoot: w.hubRoot }).filter(l => l.rule === 'root-is-link');
  assert.strictEqual(lines.length, 1, JSON.stringify(lines));
  assert.strictEqual(lines[0].path, w.ws);
  assert.strictEqual(lines[0].agent, 'agent-a');
  assert.strictEqual(lines[0].mode, 'watch');
  assert.strictEqual(lines[0].op, 'run');
});

test('buildProfile for the lead: policy.roots are writable too', () => {
  const w = world();
  const agent = { name: 'lead-a', lead: true };
  const extra = fs.realpathSync(tmpRoot());
  const policy = { ...toolPolicy.policyFor(agent), roots: [extra] };
  const p = lb.buildProfile({ agent, policy, mode: 'enforce', tool: 'Bash', command: 'ls', ...base(w) });
  assert.ok(p.writes.includes(extra), 'an extra folder granted to the lead');
  assert.deepStrictEqual(p.skipped, []);
});

test('clientCommand: the cwd file lives in the worker\'s own TMPDIR, in /tmp for the lead', () => {
  const w = world();
  const cwdOf = (profile) => decode(/--profile-b64 '([^']+)'/.exec(lb.clientCommand(profile, 'ls'))[1]).cwdFile;
  const agent = { name: 'agent-a', category: 'worker' };
  const worker = lb.buildProfile({ agent, policy: policyOf(agent, [], w), mode: 'enforce', tool: 'Bash', command: 'ls', ...base(w) });
  assert.ok(worker.env && worker.env.set.TMPDIR);
  assert.ok(cwdOf(worker).startsWith(worker.env.set.TMPDIR + path.sep + 'lockbox-cwd-'), cwdOf(worker));
  const lead = { name: 'lead-a', lead: true };
  const leadProfile = lb.buildProfile({ agent: lead, policy: toolPolicy.policyFor(lead), mode: 'enforce', tool: 'Bash', command: 'ls', ...base(w) });
  assert.strictEqual(leadProfile.env, null);
  assert.ok(cwdOf(leadProfile).startsWith('/tmp/lockbox-cwd-'), cwdOf(leadProfile));
});

test('DEV_WRITES includes /dev/ptmx', () => {
  assert.ok(lb.DEV_WRITES.includes('/dev/ptmx'));
});

test('appendLog: a log past 5 MiB moves to watch.jsonl.1', () => {
  const w = world();
  const file = path.join(w.hubRoot, 'data', 'lockbox', 'watch.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x'.repeat(5 * 1024 * 1024 + 10) + '\n');
  lb.appendLog({ ts: 't', agent: 'agent-a', tool: 'Bash', mode: 'watch', cmd: 'c', op: 'run', path: '', rule: 'r' }, { hubRoot: w.hubRoot });
  assert.ok(fs.statSync(file + '.1').size > 5 * 1024 * 1024, 'the old log was moved');
  assert.ok(fs.statSync(file).size < 1000, 'a fresh log');
  assert.deepStrictEqual(lb.readLog({ hubRoot: w.hubRoot }).map(e => e.cmd), ['c']);
  // a small log stays
  lb.appendLog({ ts: 't', agent: 'agent-a', tool: 'Bash', mode: 'watch', cmd: 'd', op: 'run', path: '', rule: 'r' }, { hubRoot: w.hubRoot });
  assert.deepStrictEqual(lb.readLog({ hubRoot: w.hubRoot }).map(e => e.cmd), ['d', 'c']);
});
