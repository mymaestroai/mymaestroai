'use strict';
// Files area (lib/files): one folder per owner, members locked to their own, no path escapes,
// uploads land whole or not at all, size limit, folder ops.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { createFiles, cleanName } = require('../lib/files');

const USERS = { u_admin: { id: 'u_admin', role: 'admin', name: 'the owner' }, u_k: { id: 'u_k', role: 'member', name: 'Sam' }, u_m: { id: 'u_m', role: 'member', name: 'Mo' } };
function make(maxBytes = 1024) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'files-'));
  const files = createFiles({ hubHome: home, getUser: (id) => USERS[id] || null, maxUploadBytes: () => maxBytes });
  return { home, files };
}
function upload(files, root, dir, name, body, opts) {
  const t = files.uploadTarget(root, dir, name, opts);
  if (!t.ok) return Promise.resolve(t);
  return files.saveStream(t, Readable.from([Buffer.from(body)]));
}

test('owner resolution: members get their own folder whatever they ask for; admins pick any owner, "mine" is the hub share', () => {
  const { home, files } = make();
  const k = files.resolveOwner(USERS.u_k, 'u_admin');
  assert.strictEqual(k.ownerId, 'u_k');
  assert.strictEqual(k.root, path.join(home, 'users', 'u_k', 'files'));
  assert.strictEqual(k.label, 'Your files');
  const a = files.resolveOwner(USERS.u_admin, undefined);
  assert.strictEqual(a.ownerId, 'mine');
  assert.strictEqual(a.root, path.join(home, 'share'));
  assert.strictEqual(files.resolveOwner(USERS.u_admin, 'infra').root, path.join(home, 'share'));
  const ak = files.resolveOwner(USERS.u_admin, 'u_k');
  assert.strictEqual(ak.root, path.join(home, 'users', 'u_k', 'files'));
  assert.strictEqual(ak.label, 'Files of Sam');
  assert.strictEqual(files.resolveOwner(USERS.u_admin, 'u_nobody'), null, 'unknown owner refused');
  assert.strictEqual(files.resolveOwner(null, 'u_k'), null);
  assert.strictEqual(files.resolveOwner(USERS.u_admin, 'u_admin').root, path.join(home, 'share'), 'an admin id maps to the share too');
});

test('paths cannot leave the root: .., absolute, symlink out', () => {
  const { home, files } = make();
  const root = files.resolveOwner(USERS.u_k).root;
  fs.mkdirSync(root, { recursive: true });
  assert.strictEqual(files.resolve(root, '../../share'), null);
  assert.strictEqual(files.resolve(root, 'a/../../x'), null);
  assert.strictEqual(files.resolve(root, '/etc/passwd'), path.join(root, 'etc', 'passwd'), 'a leading slash is just the root');
  assert.strictEqual(files.resolve(root, ''), path.resolve(root));
  fs.mkdirSync(path.join(home, 'secret')); fs.writeFileSync(path.join(home, 'secret', 's.txt'), 'x');
  fs.symlinkSync(path.join(home, 'secret'), path.join(root, 'link'));
  assert.strictEqual(files.resolve(root, 'link/s.txt'), null, 'symlink pointing outside is refused');
  assert.strictEqual(files.list(root, 'link').ok, false);
  assert.strictEqual(files.stat(root, '../share').ok, false);
  assert.strictEqual(files.remove(root, '').ok, false, 'root itself cannot be deleted');
  assert.strictEqual(files.remove(root, '..').ok, false);
});

test('upload lands whole (temp + rename), refuses an existing name unless overwrite, enforces the size limit', async () => {
  const { files } = make(16);
  const root = files.resolveOwner(USERS.u_k).root;
  const r = await upload(files, root, '', 'notes.txt', 'hello');
  assert.ok(r.ok); assert.strictEqual(r.path, 'notes.txt'); assert.strictEqual(r.entry.size, 5); assert.strictEqual(r.absPath, path.join(root, 'notes.txt'));
  assert.strictEqual(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'hello');
  const dup = await upload(files, root, '', 'notes.txt', 'again');
  assert.strictEqual(dup.ok, false); assert.strictEqual(dup.code, 409);
  const ow = await upload(files, root, '', 'notes.txt', 'again', { overwrite: true });
  assert.ok(ow.ok); assert.strictEqual(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'again');
  const big = await upload(files, root, '', 'big.bin', 'x'.repeat(40));
  assert.strictEqual(big.ok, false); assert.strictEqual(big.code, 413);
  assert.ok(!fs.existsSync(path.join(root, 'big.bin')));
  assert.deepStrictEqual(fs.readdirSync(root).filter(n => n.includes('.part-')), [], 'no temp file left behind');
  assert.strictEqual(files.uploadTarget(root, '', '../evil.txt').ok, false, 'slashes are stripped and a leading dot is refused');
  const odd = files.uploadTarget(root, '', 'a/b.txt');
  assert.ok(odd.ok); assert.strictEqual(odd.name, 'ab.txt');
  assert.strictEqual(files.uploadTarget(root, '../..', 'x.txt').ok, false, 'target folder cannot escape');
  const sub = await upload(files, root, 'reports/2026', 'q3.csv', 'a,b');
  assert.ok(sub.ok); assert.strictEqual(sub.path, 'reports/2026/q3.csv');
});

test('list sorts folders first then names, hides dot files; mkdir / rename / remove', async () => {
  const { files } = make();
  const root = files.resolveOwner(USERS.u_m).root;
  await upload(files, root, '', 'b.txt', '1'); await upload(files, root, '', 'A.txt', '22'); await upload(files, root, '', '.hidden', 'x');
  assert.ok(files.mkdir(root, '', 'zeta').ok);
  assert.strictEqual(files.mkdir(root, '', 'zeta').code, 409);
  assert.strictEqual(files.mkdir(root, '', '').code, 400);
  const l = files.list(root, '');
  assert.ok(l.ok);
  assert.deepStrictEqual(l.entries.map(e => `${e.type}:${e.name}`), ['dir:zeta', 'file:A.txt', 'file:b.txt']);
  assert.strictEqual(l.entries[2].size, 1);
  assert.strictEqual(files.list(root, 'nope').code, 404);
  assert.strictEqual(files.list(root, 'A.txt').code, 400);
  const rn = files.rename(root, 'A.txt', 'alpha.txt');
  assert.ok(rn.ok); assert.strictEqual(rn.path, 'alpha.txt');
  assert.strictEqual(files.rename(root, 'alpha.txt', 'b.txt').code, 409);
  assert.strictEqual(files.rename(root, 'alpha.txt', '../x').code, 400, 'a hidden or escaping name is refused');
  assert.ok(files.rename(root, 'alpha.txt', 'sub/x').ok, 'slashes stripped: renames to subx inside the folder');
  await upload(files, root, 'zeta', 'in.txt', 'q');
  assert.ok(files.remove(root, 'zeta').ok, 'folders are removed recursively');
  assert.ok(!fs.existsSync(path.join(root, 'zeta')));
  assert.strictEqual(files.remove(root, 'zeta').code, 404);
  const l2 = files.list(root, '');
  assert.deepStrictEqual(l2.entries.map(e => e.name), ['b.txt', 'subx']);
});

test('names are cleaned; mime by extension', () => {
  const { files } = make();
  assert.strictEqual(cleanName('  report.pdf '), 'report.pdf');
  assert.strictEqual(cleanName('a/b\\c.txt'), 'abc.txt');
  assert.strictEqual(cleanName('..'), null);
  assert.strictEqual(cleanName('.env'), null);
  assert.strictEqual(cleanName(''), null);
  assert.strictEqual(cleanName('x\u0000y'), 'xy');
  assert.strictEqual(files.mimeOf('a.PDF'), 'application/pdf');
  assert.strictEqual(files.mimeOf('a.weird'), 'application/octet-stream');
});

test('per-agent roots: members share one folder per member; medical/legal teams keep their folders; others get share/<agent>', () => {
  const { home, files } = make();
  const u = { id: 'u_admin', role: 'admin' };
  assert.strictEqual(files.rootForAgent({ name: 'maestro' }), path.join(home, 'share', 'maestro'));
  // Team folders follow the agent's own folder grant (policy.roots), never its name.
  const TP = require('../lib/tool-policy');
  const med = { policy: { roots: [path.join(TP.HUB_HOME, 'medical')] } }, leg = { policy: { roots: [path.join(TP.HUB_HOME, 'legal')] } };
  assert.strictEqual(files.rootForAgent({ name: 'gp', ...med }), path.join(home, 'medical'));
  assert.strictEqual(files.rootForAgent({ name: 'wellness', ...med }), path.join(home, 'medical'));
  assert.strictEqual(files.rootForAgent({ name: 'counsel', ...leg }), path.join(home, 'legal'));
  assert.strictEqual(files.rootForAgent({ name: 'gp' }), path.join(home, 'share', 'gp'), 'no grant: its own share folder');
  assert.strictEqual(files.rootForAgent({ name: 'sam_doc', owner: 'u_k' }, { memberOwned: true }), path.join(home, 'users', 'u_k', 'files'));
  assert.strictEqual(files.rootForAgent({ name: 'doc2', owner: 'u_admin' }, { memberOwned: false }), path.join(home, 'share', 'doc2'), 'admin-owned personal agents get their own folder');
  assert.strictEqual(files.rootForAgent({ name: 'we/ird name' }), path.join(home, 'share', 'we_ird_name'));
  const r = files.resolveAgent(u, { name: 'gp', display: 'GP', ...med });
  assert.deepStrictEqual(r, { ownerId: 'mine', agent: 'gp', root: path.join(home, 'medical'), label: 'Files of GP' });
  assert.strictEqual(files.resolveAgent(null, { name: 'gp' }), null);
});
