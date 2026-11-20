'use strict';
// "Protect your Maestro's own code" (lib/code-protect, lib/tool-policy decide/denialText, lib/work-practices ownCodeText,
// the two behaviour-change entries, the Settings switch). Nothing here writes into the install: paths are only strings.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tp = require('../lib/tool-policy');
const { createCodeProtect, REFUSAL } = require('../lib/code-protect');
const wp = require('../lib/work-practices');
const bc = require('../lib/behaviour-changes');

const ROOT = tp.HUB_ROOT;
const ROOT_DIR = path.join(__dirname, '..');
const P = (...p) => path.join(ROOT, ...p);
const make = (s, extra = {}) => createCodeProtect({ stateOf: () => s, hubRoot: ROOT, hubHome: path.join(os.tmpdir(), 'elsewhere-home'), ...extra });
const lead = { name: 'owner-lead', category: 'primary', lead: true };
const head = { name: 'sam', category: 'primary' };
const worker = { name: 'scout', category: 'worker' };
const cwdOf = (a) => P('workspaces', a.name);
const dec = (agent, tool, input, on = true) => {
  tp.setCodeProtectProvider(() => make(on ? 'on' : 'off'));
  try { return tp.decide({ agent, tool, input, cwd: cwdOf(agent) }); } finally { tp.setCodeProtectProvider(null); }
};
const refused = (d) => d.decision === 'deny' && d.protectedCode === true && d.reason === 'protected code: ' + REFUSAL;

test('state(): on, off, pending; unreadable keeps the last known state; unreadable with none protects and shows an item', () => {
  assert.deepStrictEqual(make('on').state(), { on: true, why: 'on' });
  assert.deepStrictEqual(make('off').state(), { on: false, why: 'off' });
  assert.deepStrictEqual(make('pending').state(), { on: false, why: 'off' }, 'pending = not decided = off');
  let s = 'off';
  const cp = createCodeProtect({ stateOf: () => s, hubRoot: ROOT });
  assert.strictEqual(cp.state().on, false);
  s = 'unreadable';
  assert.deepStrictEqual(cp.state(), { on: false, why: 'last-known' });
  assert.deepStrictEqual(cp.readinessItems(), [], 'a known state needs no item');
  s = 'on'; cp.state(); s = 'missing';
  assert.deepStrictEqual(cp.state(), { on: true, why: 'last-known' });

  let t = 'unreadable';
  const fresh = createCodeProtect({ stateOf: () => t, hubRoot: ROOT });
  assert.deepStrictEqual(fresh.state(), { on: true, why: 'unreadable' });
  const items = fresh.readinessItems();
  assert.strictEqual(items.length, 1);
  assert.match(items[0].detail, /Code protection is on because the Changes file can't be read: data\/behaviour-reviews\.json\./);
  assert.match(items[0].fix, /Open the Changes page and decide again, or restore the file from a backup\./);
  t = 'off';
  assert.deepStrictEqual(fresh.readinessItems(), [], 'recovered: the item is gone');
  assert.deepStrictEqual(fresh.state(), { on: false, why: 'off' });
  const thrower = createCodeProtect({ stateOf: () => { throw new Error('x'); }, hubRoot: ROOT });
  assert.deepStrictEqual(thrower.state(), { on: true, why: 'unreadable' });
});

test('isProtectedPath: the program files are, data, workspaces, node_modules and the hub home inside the root are not', () => {
  const cp = createCodeProtect({ stateOf: () => 'on', hubRoot: ROOT, hubHome: P('hub-home') });
  for (const p of [P('lib', 'x.js'), P('app.js'), P('.git', 'config'), P('scripts', 'a.sh'), P('lib', '..', 'lib', 'y.js'), P('data', '..', 'lib', 'z.js'), ROOT]) assert.strictEqual(cp.isProtectedPath(p), true, p);
  for (const p of [P('data', 'x'), P('workspaces', 'sam', 'x'), P('node_modules', 'x'), P('hub-home', 'share', 'f'), P('hub-home'), path.join(path.dirname(ROOT), 'other', 'lib', 'x.js'), '/tmp/x', '', null]) assert.strictEqual(cp.isProtectedPath(p), false, String(p));
  const outside = createCodeProtect({ stateOf: () => 'on', hubRoot: ROOT, hubHome: path.join(path.dirname(ROOT), 'home-out') });
  assert.strictEqual(outside.isProtectedPath(P('lib', 'x.js')), true);
});

test('decide(), protection on: file tools and shell writes into the program files are refused for every role', () => {
  for (const agent of [lead, head, worker]) {
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'mcp__hub__Write', 'mcp__hub__Edit']) {
      assert.ok(refused(dec(agent, tool, { file_path: P('lib', 'sdk-chat.js') })), `${agent.name} ${tool}`);
    }
    assert.ok(refused(dec(agent, 'Bash', { command: `echo x >> ${P('lib', 'a.js')}` })), `${agent.name} redirect`);
  }
  for (const cmd of [
    `sed -i s/a/b/ ${P('app.js')}`,
    `cd ${ROOT} && git stash pop`,
    `git -C ${ROOT} checkout -- lib/a.js`,
    `git -C ${ROOT} reset --hard`,
    `cd ${ROOT} && echo x >> lib/a.js`,
    `git -C ${ROOT} stash`,
    `git -C ${ROOT} commit -am wip`,
  ]) assert.ok(refused(dec(lead, 'Bash', { command: cmd })), cmd);
  assert.ok(refused(dec(head, 'mcp__hub__Bash', { command: `cd ${ROOT} && git pull` })), 'mcp__hub__Bash');
  assert.ok(refused(dec(lead, 'run_job', { name: 'j', command: `cd ${ROOT} && git pull` })), 'run_job');
  assert.ok(refused(dec(worker, 'run_job', { name: 'j', command: `cd ${ROOT} && git pull` })), 'run_job worker');
});

test('decide(), protection on: reads, git that only looks, and data / workspaces are not refused by this rule', () => {
  for (const agent of [lead, head, worker]) {
    assert.ok(!refused(dec(agent, 'Write', { file_path: P('data', 'x') })), 'data');
    assert.ok(!refused(dec(agent, 'Write', { file_path: P('workspaces', agent.name, 'x') })), 'own workspace');
    assert.ok(!refused(dec(agent, 'mcp__hub__Edit', { file_path: P('workspaces', agent.name, 'x') })), 'mcp edit workspace');
  }
  for (const cmd of [`git -C ${ROOT} status`, `git -C ${ROOT} log`, `cat ${P('lib', 'a.js')}`, `cd ${ROOT} && git diff`, `cd ${ROOT} && git commit -m x`, `git -C ${ROOT} stash list`, `git -C ${P('workspaces', 'sam')} checkout main`]) {
    assert.ok(!refused(dec(lead, 'Bash', { command: cmd })), cmd);
  }
  assert.ok(!refused(dec(lead, 'Read', { file_path: P('lib', 'a.js') })), 'Read');
});

test('decide(), protection off: none of these is refused by this rule', () => {
  for (const agent of [lead, head, worker]) {
    assert.ok(!refused(dec(agent, 'Write', { file_path: P('lib', 'sdk-chat.js') }, false)));
    assert.ok(!refused(dec(agent, 'Bash', { command: `echo x >> ${P('lib', 'a.js')}` }, false)));
    assert.ok(!refused(dec(agent, 'Bash', { command: `cd ${ROOT} && git stash pop` }, false)));
    assert.ok(!refused(dec(agent, 'run_job', { name: 'j', command: `cd ${ROOT} && git pull` }, false)));
  }
});

test('denialText of a protected-code refusal carries the refusal sentence and the instruction', () => {
  const d = dec(lead, 'Write', { file_path: P('lib', 'sdk-chat.js') });
  const t = tp.denialText(d);
  assert.ok(t.startsWith('[DENIED BY POLICY] ' + REFUSAL));
  assert.match(t, /Do not work around it: tell the owner what you wanted to change and why\./);
  assert.ok(t.includes(d.summary));
  assert.match(tp.denialText({ decision: 'deny', cls: 'write_outside', role: 'worker', reason: 'x', summary: 's' }), /writing outside your allowed folders/, 'other refusals unchanged');
});

test('work-practices: the section is the lead\'s, and only while own-code-guidance is on', () => {
  const primary = { name: 'sam', category: 'primary' };
  const text = wp.textFor({ agent: primary, isLead: true, ownCode: true });
  assert.match(text, /## YOUR MAESTRO'S OWN CODE/);
  assert.match(text, /Never put back changes that were put aside \(git stash pop or apply\)/);
  assert.strictEqual(wp.textFor({ agent: primary, isLead: true, ownCode: false }), '');
  assert.strictEqual(wp.textFor({ agent: primary, isLead: false, ownCode: true }), '', 'not a non-lead primary');
  assert.strictEqual(wp.textFor({ agent: { category: 'worker' }, isLead: true, ownCode: true }), '');
  const sdk = fs.readFileSync(path.join(ROOT_DIR, 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(sdk, /ownCode = bc\.isOn\('own-code-guidance'\);/);
  assert.match(sdk, /checkIns, suggestions, handOffs, partner, ownCode \}\)/);
});

test('behaviour changes: both entries exist (leadMay false / true); new installs get them on, existing ones pending', () => {
  const file = path.join(ROOT_DIR, 'templates', 'behaviour-changes.json');
  const m = bc.manifest(file);
  const prot = m.find((e) => e.id === 'protect-own-code'), guide = m.find((e) => e.id === 'own-code-guidance');
  assert.ok(prot && guide);
  assert.strictEqual(prot.leadMay, false);
  assert.strictEqual(guide.leadMay, true);
  for (const e of [prot, guide]) for (const k of ['title', 'changes', 'benefits', 'costs', 'check', 'on', 'off']) assert.ok(typeof e[k] === 'string' && e[k].length > 5, `${e.id}.${k}`);
  assert.doesNotMatch(JSON.stringify([prot, guide]), /\bhub\b/i, 'plain words: "your Maestro", never "hub"');
  assert.strictEqual(prot.title, "Protect your Maestro's own code");
  assert.strictEqual(guide.title, "Your lead leaves your Maestro's code alone");
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'code-protect-t-'));
  try {
    const fresh = path.join(d, 'fresh.json');
    bc.seedNew({ stateFile: fresh, manifestFile: file });
    assert.strictEqual(bc.stateOf('protect-own-code', { stateFile: fresh }), 'on');
    assert.strictEqual(bc.stateOf('own-code-guidance', { stateFile: fresh }), 'on');
    const agentsFile = path.join(d, 'agents.json'), old = path.join(d, 'old.json');
    fs.writeFileSync(agentsFile, '[]');
    fs.writeFileSync(old, JSON.stringify({ entries: { 'team-guidance': { state: 'on', by: 'owner', at: '2026-01-01T00:00:00.000Z' } } }));
    const r = bc.migrate({ agentsFile, stateFile: old, manifestFile: file });
    assert.ok(r.added.includes('protect-own-code') && r.added.includes('own-code-guidance'));
    assert.strictEqual(bc.stateOf('protect-own-code', { stateFile: old }), 'pending');
    assert.strictEqual(bc.stateOf('own-code-guidance', { stateFile: old }), 'pending');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('Settings: app.js and mobile.js show the switch for admins and post to the behaviour-change route; the playbook and readiness are wired', () => {
  for (const f of ['app.js', 'mobile.js']) {
    const src = fs.readFileSync(path.join(ROOT_DIR, f), 'utf8');
    assert.match(src, /\/api\/behaviour-changes\/protect-own-code/, f);
    assert.match(src, /decision: want/, f);
    assert.match(src, /Protect your Maestro\\'s own code/, f);
    assert.match(src, /Also on the Changes page\./, f);
    assert.match(src, /hubMe\.isAdmin \? '<div class="sec-section" id="sec-code-protect-box">/, f);
  }
  const ready = fs.readFileSync(path.join(ROOT_DIR, 'lib', 'readiness.js'), 'utf8');
  assert.match(ready, /require\('\.\/code-protect'\)\.getCodeProtect\(\)\.readinessItems\(\)/);
  const play = fs.readFileSync(path.join(ROOT_DIR, 'templates', 'workspaces', 'maestro', 'AGENT-PLAYBOOK.md'), 'utf8');
  assert.match(play, /## Your Maestro's own code\n\nThis applies when your instructions carry the rule/);
  const upd = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'templates', 'workspace-updates.json'), 'utf8'));
  const sha = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT_DIR, 'templates', 'workspaces', 'maestro', 'AGENT-PLAYBOOK.md'))).digest('hex');
  assert.strictEqual(upd['maestro/AGENT-PLAYBOOK.md'].current, sha);
});

test('review prep: GIT_WORK_TREE / GIT_DIR in front of git point it at the install; a detection error refuses; no provider reads nothing', () => {
  assert.ok(refused(dec(lead, 'Bash', { command: `GIT_WORK_TREE=${ROOT} git checkout -- lib/a.js` })));
  assert.ok(refused(dec(lead, 'Bash', { command: `GIT_DIR=${P('.git')} GIT_WORK_TREE=${ROOT} git stash pop` })));
  assert.ok(!refused(dec(lead, 'Bash', { command: `GIT_WORK_TREE=${ROOT} git status` })));
  // protection on and the command can't be read: refused, never let through
  const broken = { ...make('on'), commandWritesProtected: () => { throw new Error('scan broke'); } };
  tp.setCodeProtectProvider(() => broken);
  try { assert.ok(refused(tp.decide({ agent: lead, tool: 'Bash', input: { command: 'echo hi' }, cwd: cwdOf(lead) }))); }
  finally { tp.setCodeProtectProvider(null); }
  // no provider registered (a unit test, a script): nothing is read and nothing refused by this rule
  tp.setCodeProtectProvider(null);
  const d = tp.decide({ agent: lead, tool: 'Write', input: { file_path: P('lib', 'a.js') }, cwd: cwdOf(lead) });
  assert.notStrictEqual(d.protectedCode, true);
  // the server registers the provider before any agent runs
  const server = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');
  assert.match(server, /require\('\.\/lib\/tool-policy'\)\.setCodeProtectProvider\(\(\) => require\('\.\/lib\/code-protect'\)\.getCodeProtect\(\)\)/);
  assert.ok(server.indexOf('setCodeProtectProvider') < server.indexOf("server.listen(") || server.indexOf("server.listen(") < 0);
});
