'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { seedDefaultWorkspaces } = require('../lib/agents');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'));
  const t = path.join(root, 'templates'), w = path.join(root, 'workspaces');
  fs.mkdirSync(path.join(t, 'maestro'), { recursive: true });
  fs.writeFileSync(path.join(t, 'maestro', 'SOUL.md'), 'template soul');
  fs.writeFileSync(path.join(t, 'maestro', 'USER.md'), 'template user');
  return { root, t, w };
}

describe('workspace seeding', () => {
  it('creates a missing workspace from its template', () => {
    const { t, w } = sandbox();
    assert.deepStrictEqual(seedDefaultWorkspaces(t, w).sort(), ['maestro/SOUL.md', 'maestro/USER.md']);
    assert.strictEqual(fs.readFileSync(path.join(w, 'maestro', 'SOUL.md'), 'utf8'), 'template soul');
  });
  it('NEVER overwrites a file the user already has, and fills in only what is missing', () => {
    const { t, w } = sandbox();
    fs.mkdirSync(path.join(w, 'maestro'), { recursive: true });
    fs.writeFileSync(path.join(w, 'maestro', 'USER.md'), 'my personal details');
    assert.deepStrictEqual(seedDefaultWorkspaces(t, w), ['maestro/SOUL.md']);
    assert.strictEqual(fs.readFileSync(path.join(w, 'maestro', 'USER.md'), 'utf8'), 'my personal details');
  });
  it('is idempotent and tolerates a release that ships no templates', () => {
    const { t, w, root } = sandbox();
    seedDefaultWorkspaces(t, w);
    assert.deepStrictEqual(seedDefaultWorkspaces(t, w), []);
    assert.deepStrictEqual(seedDefaultWorkspaces(path.join(root, 'nope'), w), []);
  });
  it('the repo ships a Maestro template and tracks no workspace files', () => {
    const repo = path.join(__dirname, '..');
    for (const f of ['IDENTITY.md', 'SOUL.md', 'TOOLS.md', 'USER.md']) assert.ok(fs.existsSync(path.join(repo, 'templates', 'workspaces', 'maestro', f)), f);
  });
});

describe('shipped templates', () => {
  it('every template folder on disk is actually tracked by git (an ignore rule once skipped them silently)', () => {
    const { execFileSync } = require('child_process'); const repo = path.join(__dirname, '..');
    let tracked; try { tracked = execFileSync('git', ['ls-files', 'templates'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return; }   // not a git checkout
    const onDisk = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const a = path.join(d, e.name); e.isDirectory() ? walk(a) : onDisk.push(path.relative(repo, a).replace(/\\/g, '/')); } })(path.join(repo, 'templates'));
    assert.deepStrictEqual(onDisk.filter(f => !tracked.includes(f)), [], 'untracked template files would be missing from every other install');
    for (const agent of ['maestro']) assert.ok(tracked.some(f => f.startsWith(`templates/workspaces/${agent}/`)), `${agent} template is tracked`);
  });
});
