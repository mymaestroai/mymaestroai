'use strict';
// Where the hub keeps share/, users/, medical/ and legal/ (lib/hub-home), and `mymaestro move-home`, which moves an
// older install's folders out of the home folder. Everything happens in a throwaway "home folder" under the temp dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveHubHome, moveHome, rewritePaths, INSIDE } = require('../lib/hub-home');

const tmps = [];
test.after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

/** A home folder with an install in it: { home, root }. `make` lists folders to create under home. */
function layout({ make = [], agents = null, installDir = 'mymaestroai', settings = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-home-'));
  tmps.push(home);
  const root = path.join(home, installDir);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  for (const d of make) fs.mkdirSync(path.join(home, d), { recursive: true });
  if (agents) fs.writeFileSync(path.join(root, 'data', 'agents.json'), JSON.stringify(agents));
  if (settings) fs.writeFileSync(path.join(root, 'data', 'settings.json'), JSON.stringify(settings));
  return { home, root };
}

test('a fresh install straight in the home folder keeps its folders inside the install', () => {
  const { home, root } = layout();
  assert.strictEqual(resolveHubHome({ root, home, env: {} }), path.join(root, INSIDE));
});

test("a home folder's own share/ or legal/ does not count; the hub's own folders do", () => {
  const { home, root } = layout({ make: ['share/photos', 'legal', 'users/notes'] });
  assert.strictEqual(resolveHubHome({ root, home, env: {} }), path.join(root, INSIDE), 'nothing here was made by the hub');
  for (const sign of ['share/common', 'share/maestro', 'users/7/files']) {
    const l = layout({ make: [sign], agents: [{ name: 'maestro' }] });
    assert.strictEqual(resolveHubHome({ root: l.root, home: l.home, env: {} }), l.home, sign);
  }
  const unknownAgent = layout({ make: ['share/someone'], agents: [{ name: 'maestro' }] });
  assert.strictEqual(resolveHubHome({ root: unknownAgent.root, home: unknownAgent.home, env: {} }), path.join(unknownAgent.root, INSIDE));
});

test('an install in a folder of its own (~/agent-hub/agent-hub-5.1.0) keeps using that folder once it holds the hub folders', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-home-'));
  tmps.push(home);
  const parent = path.join(home, 'agent-hub');
  const root = path.join(parent, 'agent-hub-5.1.0');
  fs.mkdirSync(root, { recursive: true });
  assert.strictEqual(resolveHubHome({ root, home, env: {} }), path.join(root, INSIDE), 'nothing there yet: inside');
  for (const f of ['share', 'users', 'medical', 'legal']) {
    fs.mkdirSync(path.join(parent, f));
    assert.strictEqual(resolveHubHome({ root, home, env: {} }), parent, f);
    fs.rmdirSync(path.join(parent, f));
  }
});

test('HUB_HOME wins, then an existing <install>/hub-home', () => {
  const { home, root } = layout({ make: ['share/common'] });
  assert.strictEqual(resolveHubHome({ root, home, env: { HUB_HOME: '/srv/hub-files' } }), '/srv/hub-files');
  fs.mkdirSync(path.join(root, INSIDE));
  assert.strictEqual(resolveHubHome({ root, home, env: {} }), path.join(root, INSIDE), 'the inside folder beats the old one');
});

test('move-home: the plan names only what the hub made or granted, and moves nothing without apply', () => {
  const { home, root } = layout({
    make: ['share/common', 'share/maestro', 'users/7/files', 'medical/patients', 'legal'],
    agents: [{ name: 'maestro' }, { name: 'doc', policy: { roots: ['MEDICAL'] } }],
  });
  const agentsFile = path.join(root, 'data', 'agents.json');
  fs.writeFileSync(agentsFile, fs.readFileSync(agentsFile, 'utf8').replace('MEDICAL', path.join(home, 'medical')));
  const r = moveHome({ root, home, env: {} });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.plan.map(s => s.name), ['share', 'users', 'medical'], 'legal/ is not granted to any agent, so it is the home folder\'s own');
  assert.ok(fs.existsSync(path.join(home, 'share', 'maestro')) && !fs.existsSync(path.join(root, INSIDE)), 'a plan only');
});

test('move-home --yes: folders move, links stay behind, paths in data/ are rewritten (copies kept), sandboxes renewed', () => {
  const { home, root } = layout({ make: ['share/maestro', 'medical/patients'], agents: [{ name: 'maestro' }] });
  const med = path.join(home, 'medical');
  const agents = [{ name: 'maestro' }, { name: 'doc', policy: { roots: [med, '/tmp'] } }];
  fs.writeFileSync(path.join(root, 'data', 'agents.json'), JSON.stringify(agents));
  fs.writeFileSync(path.join(root, 'data', 'settings.json'), JSON.stringify({ theme: 'dark' }));
  fs.writeFileSync(path.join(home, 'share', 'maestro', 'report.md'), 'kept');
  const calls = [];
  // Two sandbox containers: abc123 mounts this install's Files folder, def456 belongs to another hub on the machine.
  const docker = (args) => {
    calls.push(args[0] === 'inspect' ? 'inspect' : args.join(' '));
    if (args[0] === 'ps') return 'abc123\ndef456\n';
    if (args[0] === 'inspect') return JSON.stringify([
      { Id: 'abc123', Mounts: [{ Source: path.join(home, 'share', 'maestro') }, { Source: '/tmp' }] },
      { Id: 'def456', Mounts: [{ Source: '/srv/other hub|x/share/x' }] },   // spaces and | in a path are fine
    ]);
    return '';
  };
  const r = moveHome({ root, home, env: {}, apply: true, docker, now: new Date(2026, 9, 22, 10, 0, 0) });
  assert.strictEqual(r.ok, true, r.error);
  const inside = path.join(root, INSIDE);
  assert.deepStrictEqual(r.done.map(s => s.name), ['share', 'medical']);
  assert.strictEqual(fs.readFileSync(path.join(inside, 'share', 'maestro', 'report.md'), 'utf8'), 'kept');
  assert.ok(fs.lstatSync(path.join(home, 'share')).isSymbolicLink(), 'a link at the old place');
  assert.strictEqual(fs.readFileSync(path.join(home, 'share', 'maestro', 'report.md'), 'utf8'), 'kept', 'old paths still work');
  const after = JSON.parse(fs.readFileSync(path.join(root, 'data', 'agents.json'), 'utf8'));
  assert.deepStrictEqual(after[1].policy.roots, [path.join(inside, 'medical'), '/tmp']);
  assert.ok(fs.existsSync(path.join(root, 'data', 'agents.json.bak-move-home-20261022-100000')));
  assert.ok(!fs.existsSync(path.join(root, 'data', 'settings.json.bak-move-home-20261022-100000')), 'nothing to rewrite there, so no copy');
  assert.deepStrictEqual(calls, ['ps -aq --filter label=agent-hub=sandbox', 'inspect', 'rm -f abc123'], "only the container that used a moved folder; the other hub's stays");
  assert.strictEqual(resolveHubHome({ root, home, env: {} }), inside, 'the hub now finds them inside');
  const again = moveHome({ root, home, env: {} });
  assert.deepStrictEqual(again.plan, [], 'a second run has nothing to move');
});

test('move-home: a failure part-way is undone, so the hub finds everything where it was', () => {
  const b = layout({ make: ['share/common', 'users/3/files'] });
  let n = 0;
  const flaky = (from, to) => { if (++n === 2) throw new Error('disk full'); fs.renameSync(from, to); };
  const r = moveHome({ root: b.root, home: b.home, env: {}, apply: true, rename: flaky });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /was undone, so everything is where it was: disk full/);
  assert.strictEqual(r.rolledBack, true);
  assert.strictEqual(r.partial, false);
  assert.ok(fs.statSync(path.join(b.home, 'share')).isDirectory() && !fs.lstatSync(path.join(b.home, 'share')).isSymbolicLink(), 'share/ is back in place');
  assert.ok(fs.existsSync(path.join(b.home, 'share', 'common')));
  assert.ok(!fs.existsSync(path.join(b.root, INSIDE)), 'the inside folder is gone again');
  assert.strictEqual(resolveHubHome({ root: b.root, home: b.home, env: {} }), b.home);
});

test('move-home does nothing for installs that are fine, or when HUB_HOME is set', () => {
  const fresh = layout();
  assert.deepStrictEqual(moveHome({ root: fresh.root, home: fresh.home, env: {} }).plan, []);
  const pinned = layout({ make: ['share/common'] });
  const r = moveHome({ root: pinned.root, home: pinned.home, env: { HUB_HOME: pinned.home } });
  assert.deepStrictEqual(r.plan, []);
  assert.match(r.notes[0], /HUB_HOME is set/);
});

test('rewritePaths replaces a folder prefix only at a path boundary', () => {
  const [v, changed] = rewritePaths({ a: ['/h/share', '/h/share/x', '/h/shared', 'other'], b: { c: '/h/share/y' } }, [['/h/share', '/h/m/hub-home/share']]);
  assert.strictEqual(changed, true);
  assert.deepStrictEqual(v, { a: ['/h/m/hub-home/share', '/h/m/hub-home/share/x', '/h/shared', 'other'], b: { c: '/h/m/hub-home/share/y' } });
});

test('move-home refuses, before changing anything, when a folder holds more than the hub\'s or is a link', () => {
  const extra = layout({ make: ['share/common', 'share/maestro', 'share/photos'], agents: [{ name: 'maestro' }] });
  let r = moveHome({ root: extra.root, home: extra.home, env: {}, apply: true });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Nothing was moved\..*share also holds things that are not the hub's \(photos\)/);
  assert.ok(fs.existsSync(path.join(extra.home, 'share', 'photos')) && !fs.existsSync(path.join(extra.root, INSIDE)));

  const users = layout({ make: ['share/common', 'users/3/files', 'users/notes'] });
  r = moveHome({ root: users.root, home: users.home, env: {} });
  assert.match(r.error, /users also holds things that are not members' folders \(notes\)/);

  const linked = layout({ make: ['elsewhere/share/common'] });
  fs.symlinkSync(path.join(linked.home, 'elsewhere', 'share'), path.join(linked.home, 'share'));
  r = moveHome({ root: linked.root, home: linked.home, env: {}, apply: true });
  assert.match(r.error, /share is a link to somewhere else/);
  assert.ok(fs.lstatSync(path.join(linked.home, 'share')).isSymbolicLink() && !fs.existsSync(path.join(linked.root, INSIDE)));
});

test('team folders: a "~/medical" grant counts; a grant of only part of the folder stops the move', () => {
  const whole = layout({ make: ['share/common', 'medical/patients'], agents: [{ name: 'doc', policy: { roots: ['~/medical'] } }] });
  assert.deepStrictEqual(moveHome({ root: whole.root, home: whole.home, env: {} }).plan.map(s => s.name), ['share', 'medical']);
  const part = layout({ make: ['share/common', 'medical/export', 'medical/private'], agents: [{ name: 'doc', policy: { roots: ['~/medical/export'] } }] });
  const r = moveHome({ root: part.root, home: part.home, env: {}, apply: true });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Only part of .*medical is granted to an agent/);
  assert.ok(fs.existsSync(path.join(part.home, 'medical', 'private')) && !fs.existsSync(path.join(part.root, INSIDE)));
});

test('all or nothing: a failure while saving data/agents.json, or while leaving a link, puts every folder back', () => {
  const a = layout({ make: ['share/common', 'medical/patients'], agents: [{ name: 'doc', policy: { roots: ['MED'] } }] });
  const agentsFile = path.join(a.root, 'data', 'agents.json');
  fs.writeFileSync(agentsFile, fs.readFileSync(agentsFile, 'utf8').replace('MED', path.join(a.home, 'medical')));
  const before = fs.readFileSync(agentsFile, 'utf8');
  const failOnJson = (from, to) => { if (to === agentsFile) throw new Error('disk full'); fs.renameSync(from, to); };
  let r = moveHome({ root: a.root, home: a.home, env: {}, apply: true, rename: failOnJson });
  assert.strictEqual(r.rolledBack, true, r.error);
  assert.strictEqual(fs.readFileSync(agentsFile, 'utf8'), before, 'agents.json as it was');
  assert.ok(!fs.existsSync(`${agentsFile}.move-home-tmp`), 'no temp file left');
  for (const f of ['share', 'medical']) assert.ok(fs.statSync(path.join(a.home, f)).isDirectory() && !fs.lstatSync(path.join(a.home, f)).isSymbolicLink(), f);
  assert.strictEqual(resolveHubHome({ root: a.root, home: a.home, env: {} }), a.home);

  const b = layout({ make: ['share/common'] });
  r = moveHome({ root: b.root, home: b.home, env: {}, apply: true, symlink: () => { throw new Error('no links here'); } });
  assert.strictEqual(r.rolledBack, true);
  assert.ok(fs.existsSync(path.join(b.home, 'share', 'common')), 'the folder renamed before the failed link is back');
  assert.ok(!fs.existsSync(path.join(b.root, INSIDE)));
});

test('a leftover hub-home after an undo counts as not undone: the hub must not start on it', () => {
  const c = layout({ make: ['share/common'] });
  const inside = path.join(c.root, INSIDE);
  const r = moveHome({ root: c.root, home: c.home, env: {}, apply: true,
    symlink: () => { fs.writeFileSync(path.join(inside, 'stray-file'), 'x'); throw new Error('no links here'); } });
  assert.strictEqual(r.partial, true);
  assert.strictEqual(r.rolledBack, false);
  assert.match(r.error, /could not be fully undone: .*hub-home: could not be removed/);
  assert.ok(fs.existsSync(path.join(c.home, 'share', 'common')), 'the folder itself is back');
});
