'use strict';
// records.write(..., { requireLoaded }): a replacement the loader would not load is refused BEFORE the file is touched.
// Runs on a copy of lib/ inside a temp hub under os.tmpdir(); nothing under the install's data/ or workspaces/ is used.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REAL = path.resolve(__dirname, '..');
const roots = [];
function load(cap) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'records-reqload-')); roots.push(root);
  const hub = path.join(root, 'hub');
  fs.mkdirSync(path.join(hub, 'lib'), { recursive: true });
  for (const f of ['records.js', 'path-confine.js', 'timezone.js']) fs.copyFileSync(path.join(REAL, 'lib', f), path.join(hub, 'lib', f));
  fs.writeFileSync(path.join(hub, 'lib', 'settings.js'), `module.exports = { getSetting: (k, d) => (k === "recordsMaxBytes" ? ${cap} : d) };`);
  return { rec: require(path.join(hub, 'lib', 'records.js')), hub };
}
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

test('requireLoaded: an oversize replacement leaves the file byte for byte and returns the refusal; without it the old behaviour holds', () => {
  const { rec, hub } = load(300);
  const file = path.join(hub, 'workspaces', 'boss', 'records', 'team-practice.md');
  const original = '# Team practice\n\n- keep the reviews short\n';
  assert.match(rec.write('boss', 'team-practice.md', original), /written/);
  const big = '# Team practice\n\n' + '- a very long note\n'.repeat(40);
  const r = rec.write('boss', 'team-practice.md', big, { requireLoaded: true });
  assert.match(r, /^not written: team-practice\.md would not fit in boss's Records \(\d+ of 300 characters\)/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), original, 'the previous file is untouched');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['team-practice.md'], 'no temp file left');
  const old = rec.write('boss', 'team-practice.md', big);
  assert.match(old, /will NOT be loaded/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), big, 'without the option the file is replaced as before');
});

test('requireLoaded: a replacement that fits is written; other Records count; a new file works too', () => {
  const { rec, hub } = load(300);
  const dir = path.join(hub, 'workspaces', 'boss', 'records');
  rec.write('boss', 'a-facts.md', 'x'.repeat(200));
  rec.write('boss', 'team-practice.md', 'old');
  // 200 loaded before it + 150 would pass the cap of 300
  assert.match(rec.write('boss', 'team-practice.md', 'y'.repeat(150), { requireLoaded: true }), /^not written:/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'team-practice.md'), 'utf8'), 'old');
  const ok = rec.write('boss', 'team-practice.md', 'y'.repeat(50), { requireLoaded: true });
  assert.match(ok, /Record team-practice\.md written/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'team-practice.md'), 'utf8'), 'y'.repeat(50));
  assert.match(rec.write('boss', 'fresh.md', 'z'.repeat(500), { requireLoaded: true }), /^not written:/);
  assert.ok(!fs.existsSync(path.join(dir, 'fresh.md')));
  assert.match(rec.write('boss', 'fresh.md', 'z'.repeat(20), { requireLoaded: true }), /written/);
});
