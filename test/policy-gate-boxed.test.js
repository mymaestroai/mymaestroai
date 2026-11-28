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
  assert.match(src, /beforeCall: \(name, args\) => \{ noteToolForSettings\(agentName, name\); return readOnlyHelper && name === 'Bash' \? \{ allowed: true \} : gate\.check\(\{ agentName, tool: name, input: args, cwd: hubHands \? hands\.tools\.cwd : cwd, boxed: !!hands\.sandboxed,/);
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
  // (Read was here: the readers now get the same explicit allow, see the reader tests below)
  assert.deepStrictEqual(await hook(pre('WebSearch', { query: 'x' })), {}, 'other tools: no explicit decision, as before');
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

// Review r1 (GPT-5.6 BLOCK, Sonnet): the policy judges the path as written, the client's write follows symlinks. A link
// inside an allowed folder must not carry an explicitly allowed Write somewhere the policy refuses.
test('client Write through a symlink: the real target is judged too; a link into hub data is blocked, a plain path still allowed', async () => {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-link-'));
  try {
    fs.mkdirSync(path.join(tp.HUB_ROOT, 'data'), { recursive: true });
    fs.symlinkSync(path.join(tp.HUB_ROOT, 'data'), path.join(root, 'link'));
    const worker = { name: 'w-2', category: 'worker', policy: { roots: [root] } };
    const g = gateFor(worker);
    const hook = g.sdkHook({ agentName: 'w-2', cwd: root });
    const through = await hook(pre('Write', { file_path: path.join(root, 'link', 'agents.json'), content: 'x' }));
    assert.strictEqual(through.decision, 'block', 'the real target is hub data');
    assert.ok(!through.hookSpecificOutput, 'never an explicit allow through the link');
    const plain = await hook(pre('Write', { file_path: path.join(root, 'notes.md'), content: 'x' }));
    assert.strictEqual(plain.hookSpecificOutput && plain.hookSpecificOutput.permissionDecision, 'allow', 'a plain path inside the roots: explicit allow');
    const rel = await hook(pre('Edit', { file_path: 'link/settings.json', old_string: 'a', new_string: 'b' }));
    assert.strictEqual(rel.decision, 'block', 'a relative path through the link: blocked too');
    // Review r2 (GPT-5.6): a dangling link (its target does not exist yet) is refused, not judged by the path as written
    fs.symlinkSync(path.join(tp.HUB_ROOT, 'data', 'not-there-yet.json'), path.join(root, 'dangling.json'));
    const dangling = await hook(pre('Write', { file_path: path.join(root, 'dangling.json'), content: 'x' }));
    assert.strictEqual(dangling.decision, 'block', 'a dangling link is refused');
    fs.symlinkSync(path.join(root, 'nowhere-dir'), path.join(root, 'dangling-dir'));
    const viaDir = await hook(pre('Write', { file_path: path.join(root, 'dangling-dir', 'x.txt'), content: 'x' }));
    assert.strictEqual(viaDir.decision, 'block', 'a path through a dangling folder link is refused');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('policy off is a flag on the check result, not the reason text', async () => {
  const lead = { name: 'lead-b', category: 'primary', lead: true };
  const off = createGate({ getAgent: async () => lead, approvalsOn: () => false, log: () => {}, enabled: () => false });
  const r = await off.check({ agentName: 'lead-b', tool: 'Write', input: { file_path: '/opt/x/y.txt' }, cwd: '/opt' });
  assert.strictEqual(r.policyOff, true);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'policy-gate.js'), 'utf8');
  assert.match(src, /r\.policyOff !== true/);
  assert.doesNotMatch(src, /reason === 'policy disabled'/);
});

// The client's readers (Read, Glob, Grep, NotebookRead) ask for any path outside the working folder, like the writers: an
// allowed read answers allow explicitly; a refused one is still a block; the real file or folder walked is judged too.
const isAllow = (r) => !!(r && r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'allow' && r.hookSpecificOutput.hookEventName === 'PreToolUse');

test('client readers outside the working folder: an allowed read answers allow; secrets still blocked for a worker; policy off unchanged', async () => {
  const os = require('os');
  const lead = { name: 'lead-r', category: 'primary', lead: true };
  const hook = gateFor(lead).sdkHook({ agentName: 'lead-r', cwd: '/opt/fake-install' });
  assert.ok(isAllow(await hook(pre('Read', { file_path: '/opt/fake-home/share/lead-r/scan.png' }))), 'Read of an image outside');
  assert.ok(isAllow(await hook(pre('NotebookRead', { notebook_path: '/opt/fake-home/share/lead-r/n.ipynb' }))), 'NotebookRead');
  assert.ok(isAllow(await hook(pre('Glob', { pattern: '**/*.pdf', path: '/opt/fake-home/share/lead-r' }))), 'Glob with a path');
  assert.ok(isAllow(await hook(pre('Grep', { pattern: 'dose', path: '/opt/fake-home/share/lead-r', glob: '*.md' }))), 'Grep with a path');
  assert.ok(isAllow(await hook(pre('Glob', { pattern: '/opt/fake-home/share/lead-r/*.md' }))), 'Glob with an absolute pattern');
  assert.deepStrictEqual(await hook(pre('mcp__hub__Read', { file_path: '/opt/fake-home/share/lead-r/x' })), {}, 'the hub\'s own Read: unchanged');
  const wh = gateFor({ name: 'w-r', category: 'worker' }).sdkHook({ agentName: 'w-r', cwd: '/opt/fake-install' });
  for (const [tool, input] of [
    ['Read', { file_path: path.join(tp.HUB_ROOT, '.env') }],
    ['Read', { file_path: path.join(tp.HUB_ROOT, 'data', 'auth.db') }],
    ['Read', { file_path: path.join(os.homedir(), '.claude', '.credentials.json') }],
    ['Read', { file_path: '~/.ssh/id_ed25519' }],
    ['Grep', { pattern: 'token', path: path.join(os.homedir(), '.ssh') }],
    ['Glob', { pattern: path.join(os.homedir(), '.claude', '*') }],
    ['Glob', { pattern: '~/.ssh/*' }],
  ]) {
    const d = await wh(pre(tool, input));
    assert.strictEqual(d.decision, 'block', `${tool} ${JSON.stringify(input)}: blocked`);
    assert.ok(!d.hookSpecificOutput, `${tool}: never an allow`);
  }
  const off = createGate({ getAgent: async () => lead, approvalsOn: () => false, log: () => {}, enabled: () => false });
  assert.deepStrictEqual(await off.sdkHook({ agentName: 'lead-r', cwd: '/opt/fake-install' })(pre('Read', { file_path: '/opt/fake-home/x.png' })), {}, 'policy off: unchanged');
});

test('client searches: a folder holding protected files is not searched whole outside the working folder; inside it the client decides as before; ".." after a wildcard and /proc refused', async () => {
  const os = require('os');
  const lead = { name: 'lead-s', category: 'primary', lead: true };
  const hook = gateFor(lead).sdkHook({ agentName: 'lead-s', cwd: '/opt/fake-install' });
  for (const [tool, input] of [
    ['Grep', { pattern: 'x', path: tp.HUB_ROOT }],
    ['Glob', { pattern: '**/*', path: os.homedir() }],
    ['Grep', { pattern: 'x', path: '/' }],
    ['Grep', { pattern: 'KEY', path: '/proc/self' }],
    ['Glob', { pattern: '/proc/*/environ' }],
    ['Glob', { pattern: 'a/*/../../../x', path: '/opt/fake-home' }],
  ]) {
    const d = await hook(pre(tool, input));
    assert.strictEqual(d.decision, 'block', `${tool} ${JSON.stringify(input)}: blocked`);
    assert.ok(!d.hookSpecificOutput);
  }
  // a search of the working folder (no path), which holds hub data: no explicit decision, the client's own rule as before
  fs.mkdirSync(path.join(tp.HUB_ROOT, 'data'), { recursive: true });
  const inHome = gateFor(lead).sdkHook({ agentName: 'lead-s', cwd: tp.HUB_ROOT });
  assert.deepStrictEqual(await inHome(pre('Grep', { pattern: 'x' })), {});
  assert.deepStrictEqual(await inHome(pre('Glob', { pattern: '**/*.js' })), {});
});

test('client reads through a symlink: the real file or folder is judged; a link into hub data is blocked; a dangling link is blocked', async () => {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-rlink-'));
  try {
    fs.mkdirSync(path.join(tp.HUB_ROOT, 'data'), { recursive: true });
    fs.symlinkSync(path.join(tp.HUB_ROOT, 'data'), path.join(root, 'link'));
    fs.writeFileSync(path.join(root, 'notes.md'), 'x');
    const hook = gateFor({ name: 'w-s', category: 'worker', policy: { roots: [root] } }).sdkHook({ agentName: 'w-s', cwd: root });
    for (const [tool, input] of [
      ['Read', { file_path: path.join(root, 'link', 'auth.db') }],
      ['Read', { file_path: 'link/users.json' }],
      ['Grep', { pattern: 'x', path: path.join(root, 'link') }],
      ['Glob', { pattern: 'link/*.json' }],
    ]) {
      const d = await hook(pre(tool, input));
      assert.strictEqual(d.decision, 'block', `${tool} ${JSON.stringify(input)}: blocked through the link`);
      assert.ok(!d.hookSpecificOutput);
    }
    assert.ok(isAllow(await hook(pre('Read', { file_path: path.join(root, 'notes.md') }))), 'a plain file: allowed');
    fs.symlinkSync(path.join(tp.HUB_ROOT, 'data', 'not-there.png'), path.join(root, 'dangling.png'));
    assert.strictEqual((await hook(pre('Read', { file_path: path.join(root, 'dangling.png') }))).decision, 'block', 'a dangling link is refused');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Review r1 (GPT-5.6 BLOCK): brace alternatives expand to literal paths, so a '..' or an absolute or '~' path inside braces
// escapes the folder that was judged.
test('Glob patterns: a ".." anywhere after the literal start, or an absolute or ~ path inside braces, is refused; plain patterns judged by their folder', async () => {
  const lead = { name: 'lead-g', category: 'primary', lead: true };
  const hook = gateFor(lead).sdkHook({ agentName: 'lead-g', cwd: '/opt/fake-install' });
  for (const pattern of ['{ordinary,../../data}/**/*', '{x,/proc/self/environ}', '{a,~/.ssh}/*', 'docs/{..,x}/y', '*/x/../../z', '{.,x}./data/*', '@(..|x)/y', '{a,{b,../../data}}/*', 'a/+(..)/b', '{a,\\},../..}/x', '\\.\\./\\.\\./data/*', '{{a,../..}}/x', '{'.repeat(100000), 'x'.repeat(1025), '.{.}/x', '{.}{.}/x', '.{{.}}/x', '.{{.,x}}/x', '{a,b}'.repeat(8) + '{'.repeat(980), '{a,b}'.repeat(33)]) {
    const d = await hook(pre('Glob', { pattern, path: '/opt/fake-home/share/lead-g' }));
    assert.strictEqual(d.decision, 'block', `${pattern}: blocked`);
    assert.ok(!d.hookSpecificOutput);
  }
  // still allowed: braces and classes that stay inside, a pattern with no wildcard, a leading '..' that lands in an
  // allowed folder, a '~' pattern for the lead
  for (const [pattern, p] of [['{a,b}/*.{md,txt}', '/opt/fake-home/share/lead-g'], ['[ab]*.md', '/opt/fake-home/share/lead-g'],
    ['/opt/fake-home/share/lead-g/a.md', undefined], ['../fake-home/share/lead-g/*.md', undefined], ['~/projects/*.md', undefined], ['report..md', '/opt/fake-home/share/lead-g'], ['{1..3}.md', '/opt/fake-home/share/lead-g'], ['notes/v1..2/*.md', '/opt/fake-home/share/lead-g'], ['{ a, /etc}/*', '/opt/fake-home/share/lead-g']]) {
    assert.ok(isAllow(await hook(pre('Glob', p ? { pattern, path: p } : { pattern }))), `${pattern}: allowed`);
  }
  // a leading '..' that lands on a protected folder is judged there
  const wh = gateFor({ name: 'w-g', category: 'worker' }).sdkHook({ agentName: 'w-g', cwd: path.join(tp.HUB_ROOT, 'workspaces', 'w-g') });
  assert.strictEqual((await wh(pre('Glob', { pattern: '../../data/*.json' }))).decision, 'block', 'a leading .. into hub data');
});

// Review r1 (GPT-5.6 BLOCK; Sentinel FOLLOW-UP, reproduced on the copy: a worker's Grep with no path returned .env lines):
// a Grep opens every file in its folder, so an agent whose policy refuses protected reads may not Grep a folder holding any.
test('Grep: a worker may not search a folder holding files protected by name or hub data (inside the working folder too); the lead may; Glob unchanged', async () => {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-grep-'));
  try {
    for (const d of ['keys', 'envs', 'plain/sub']) fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.writeFileSync(path.join(root, 'keys', 'private.key'), 'x');
    fs.writeFileSync(path.join(root, 'envs', '.env.production'), 'x');
    fs.writeFileSync(path.join(root, 'plain', 'sub', 'notes.md'), 'x');
    fs.symlinkSync(path.join(root, 'keys', 'private.key'), path.join(root, 'plain', 'link.key'));   // a link: not followed by Grep
    const worker = { name: 'w-q', category: 'worker', policy: { roots: [root] } };
    const wh = gateFor(worker).sdkHook({ agentName: 'w-q', cwd: '/opt/fake-install' });
    // a key named file inside a folder granted to the worker is its own (tool-policy keyRoots): that folder can be searched;
    // an .env file is private everywhere, so a folder holding one can't
    assert.ok(isAllow(await wh(pre('Grep', { pattern: 'x', path: path.join(root, 'keys') }))), 'a key in the granted folder: allowed');
    for (const p of [path.join(root, 'envs'), root]) {
      const d = await wh(pre('Grep', { pattern: 'x', path: p }));
      assert.strictEqual(d.decision, 'block', `worker Grep ${p}: blocked`);
      assert.match(d.reason, /protected file/);
    }
    // the same key folder for a worker it was not granted to: refused
    const other = { name: 'w-q2', category: 'worker' };
    const oh = gateFor(other).sdkHook({ agentName: 'w-q2', cwd: '/opt/fake-install' });
    assert.strictEqual((await oh(pre('Grep', { pattern: 'x', path: path.join(root, 'keys') }))).decision, 'block', 'not granted: blocked');
    assert.ok(isAllow(await wh(pre('Grep', { pattern: 'x', path: path.join(root, 'plain') }))), 'a folder with no protected file: allowed');
    assert.ok(isAllow(await wh(pre('Glob', { pattern: '**/*', path: root }))), 'Glob lists names only: allowed');
    const lh = gateFor({ name: 'lead-q', category: 'primary', lead: true }).sdkHook({ agentName: 'lead-q', cwd: '/opt/fake-install' });
    assert.ok(isAllow(await lh(pre('Grep', { pattern: 'x', path: root }))), 'the lead may (its policy allows protected reads)');
    // inside the working folder (the install root, which holds .env and data/): the worker's Grep is refused, its Glob and
    // the lead's Grep keep the client's own rule (no decision), as before
    fs.mkdirSync(path.join(tp.HUB_ROOT, 'data'), { recursive: true });
    const wIn = gateFor(worker).sdkHook({ agentName: 'w-q', cwd: tp.HUB_ROOT });
    assert.strictEqual((await wIn(pre('Grep', { pattern: 'PORT' }))).decision, 'block', 'worker Grep of the install root');
    assert.deepStrictEqual(await wIn(pre('Glob', { pattern: '**/*.js' })), {}, 'worker Glob there: as before');
    const lIn = gateFor({ name: 'lead-q', category: 'primary', lead: true }).sdkHook({ agentName: 'lead-q', cwd: tp.HUB_ROOT });
    assert.deepStrictEqual(await lIn(pre('Grep', { pattern: 'PORT' })), {}, 'lead Grep there: as before');
    // Review r2 (Sentinel BLOCK): for the lead and admin agents a protected read is an ask. While approval cards are on
    // for it, a direct Read would show a card, so a whole-folder Grep (which can't) is refused; cards off: unchanged.
    const lead = { name: 'lead-q', category: 'primary', lead: true };
    const head = { name: 'head-q', category: 'primary' };
    for (const [who, opts] of [[lead, { approvalsOn: () => true }], [head, { approvalsOn: () => false, approvalClasses: () => new Set(['admin']) }]]) {
      const g = createGate({ getAgent: async () => who, log: () => {}, ...opts });
      const inside = g.sdkHook({ agentName: who.name, cwd: tp.HUB_ROOT });
      assert.strictEqual((await inside(pre('Grep', { pattern: 'PORT' }))).decision, 'block', `${who.name}, cards on: Grep of the install root refused`);
      const outside = g.sdkHook({ agentName: who.name, cwd: '/opt/fake-install' });
      assert.strictEqual((await outside(pre('Grep', { pattern: 'x', path: path.join(root, 'keys') }))).decision, 'block', `${who.name}, cards on: Grep over a key file refused`);
      assert.deepStrictEqual(await inside(pre('Glob', { pattern: '**/*.js' })), {}, `${who.name}: Glob unchanged`);
    }
    const headOff = gateFor(head).sdkHook({ agentName: 'head-q', cwd: tp.HUB_ROOT });
    assert.deepStrictEqual(await headOff(pre('Grep', { pattern: 'PORT' })), {}, 'admin agent, cards off: as before');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// r2-read-fix2: a worker's Grep of a repository clone must work. A template (.env.example) is not a secret; the wallet
// code is not a keystore; installed dependencies, version control and tool caches are not scanned (and don't count
// towards the limit); a real .env or key file in the clone itself is still refused.
test('Grep of a clone-shaped folder: .env.example, wallet code and a large node_modules are allowed; a real .env or key is refused', async () => {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-clone-'));
  try {
    const w = (rel, body = 'x') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
    for (const f of ['.env.example', 'config/app.env.sample', 'keys/signing.key.template', 'lib/wallet/keystore.js', 'test/wallet-keystore.test.js', 'README.md']) w(f);
    // dependencies and version control: their own test keys and sample .env files, and more entries than the limit
    for (const f of ['node_modules/pkg-a/test/fixtures/private.key', 'node_modules/pkg-a/.env', '.git/config', 'venv/lib/site/x.pem', '__pycache__/m.pyc']) w(f);
    const many = path.join(root, 'node_modules', 'big');
    fs.mkdirSync(many, { recursive: true });
    for (let i = 0; i < 51000; i++) fs.writeFileSync(path.join(many, `f${i}.js`), '');
    const worker = { name: 'w-c', category: 'worker', policy: { roots: [root] } };
    const wh = gateFor(worker).sdkHook({ agentName: 'w-c', cwd: '/opt/fake-install' });
    assert.ok(isAllow(await wh(pre('Grep', { pattern: 'x', path: root }))), 'a clone with templates, wallet code and dependencies: allowed');
    assert.ok(isAllow(await wh(pre('Read', { file_path: path.join(root, '.env.example') }))), 'a template can be read');
    assert.ok(isAllow(await wh(pre('Read', { file_path: path.join(root, 'lib', 'wallet', 'keystore.js') }))), 'the wallet code can be read');
    // a key file in the granted folder is the worker's own; another worker may not search the folder holding it
    w('keys/deploy.pem');
    assert.ok(isAllow(await wh(pre('Grep', { pattern: 'x', path: root }))), 'a key in the granted folder: allowed');
    const oh = gateFor({ name: 'w-c2', category: 'worker' }).sdkHook({ agentName: 'w-c2', cwd: '/opt/fake-install' });
    assert.strictEqual((await oh(pre('Grep', { pattern: 'x', path: root }))).decision, 'block', 'not granted: refused');
    fs.rmSync(path.join(root, 'keys/deploy.pem'));
    for (const real of ['.env', 'config/.env.local', 'deploy/.env.production', 'data/wallet-keystore.json']) {
      w(real);
      const d = await wh(pre('Grep', { pattern: 'x', path: root }));
      assert.strictEqual(d.decision, 'block', `${real} in the clone: refused`);
      assert.match(d.reason, /protected file/);
      assert.strictEqual((await wh(pre('Read', { file_path: path.join(root, real) }))).decision, 'block', `${real}: Read refused`);
      fs.rmSync(path.join(root, real));
    }
    // more than the limit outside the skipped folders: still refused, with its own message
    const lots = path.join(root, 'assets');
    fs.mkdirSync(lots);
    for (let i = 0; i < 50001; i++) fs.writeFileSync(path.join(lots, `a${i}`), '');
    assert.match((await wh(pre('Grep', { pattern: 'x', path: root }))).reason || '', /too large/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
