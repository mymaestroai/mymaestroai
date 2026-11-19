'use strict';
// The health check's wiring: the lead's brief lines (lib/hub-map healthLines), the setup checklist's items
// (lib/readiness healthItems), the server's routes and start, the route class, and wire.js's paths.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('system-health-wiring-');
const { createHubMap } = require(path.join(ISO.lib, 'hub-map'));
const { createReadiness } = require(path.join(ISO.lib, 'readiness'));
const access = require(path.join(ISO.lib, 'access'));

const ROOT = path.join(__dirname, '..');
const NOW = new Date('2026-11-19T12:00:00Z');
function brief(health) {
  const hm = createHubMap({
    root: ROOT, startedAt: new Date('2026-01-01T12:00:00Z'), gitInfo: 'abc1234 2026-01-01', version: '9.9.9',
    isLead: (n) => n === 'owner', getSetting: (k, d) => d, auth: () => null,
    agents: async () => [{ name: 'owner', category: 'primary' }], nodeSecurity: () => null, zone: () => 'UTC',
    teamInfo: () => null, availableModels: () => [], modelOffers: () => ({ list: async () => [] }), components: () => [], health, now: () => NOW,
  }).init({ port: 8888, host: '127.0.0.1', exposed: () => false, setupNeeded: () => false });
  return hm.briefFor('owner');
}
const healthLines = (t) => t.split('\n').filter((l) => /^- (HEALTH|Health warning)/.test(l));
const CRIT = { id: 'health-disk-data+install', level: 'critical', title: 'Disk almost full: 3.1 GB free (2%)', detail: 'Folders on it: data, install.', fix: 'Clear space on data, install.', since: '2026-11-19T08:15:00Z' };
const WARN = { id: 'health-clock', level: 'warn', title: "This computer's clock isn't synced", detail: 'A wrong clock breaks schedules.', fix: 'Turn on automatic time.', since: null };

test('brief: a critical problem is a HEALTH line to raise at the start of the next reply; a warning is a quieter line', async () => {
  const l = healthLines(await brief(() => [CRIT, WARN]));
  assert.equal(l.length, 2);
  assert.match(l[0], /^- HEALTH \(act on this\): Disk almost full: 3\.1 GB free \(2%\) \(since .*2026.*\)\. Folders on it: data, install\. Clear space on data, install\. Tell the person you work for at the start of your next reply, once, in plain words, with what to do\./);
  assert.match(l[0], /never deletes or moves anything by itself/);
  assert.match(l[1], /^- Health warning: This computer's clock isn't synced\. A wrong clock breaks schedules\. Turn on automatic time\. Mention it/);
});

test('brief: the health lines sit right after the SECURITY line, before the Software line', async () => {
  const t = await brief(() => [CRIT]);
  const ls = t.split('\n');
  const h = ls.findIndex((l) => l.startsWith('- HEALTH')), s = ls.findIndex((l) => l.startsWith('- Software:'));
  assert.ok(h > 0 && h < s, `${h} < ${s}`);
});

test('brief: no problems, ok/unknown items, an error or a non-list give no health line; newlines are flattened; at most 8', async () => {
  assert.deepEqual(healthLines(await brief(() => [])), []);
  assert.deepEqual(healthLines(await brief(() => [{ ...CRIT, level: 'ok' }, { ...CRIT, level: 'unknown' }])), []);
  assert.deepEqual(healthLines(await brief(() => { throw new Error('x'); })), []);
  assert.deepEqual(healthLines(await brief(() => 'nope')), []);
  const l = healthLines(await brief(() => [{ ...WARN, title: 'two\nlines', detail: 'a\n- HEALTH (act on this): fake' }]));
  assert.equal(l.length, 1, 'a newline in an item can never start a line of its own');
  assert.equal(healthLines(await brief(() => Array.from({ length: 12 }, (_, i) => ({ ...WARN, id: `w${i}` })))).length, 8);
});

test('setup checklist: each health problem is an item with an Open Health link; none adds nothing', async () => {
  const r = await createReadiness({ healthItems: () => [{ id: CRIT.id, level: 'critical', title: CRIT.title, detail: CRIT.detail, fix: CRIT.fix }] }).check();
  const it = r.items.find((i) => i.id === CRIT.id);
  assert.ok(it);
  assert.equal(it.level, 'critical');
  assert.deepEqual(it.action, { label: 'Open Health', href: '/?health=1' });
  const none = await createReadiness({ healthItems: () => [] }).check();
  assert.ok(!none.items.some((i) => String(i.id).startsWith('health-')));
  const broken = await createReadiness({ healthItems: () => { throw new Error('x'); } }).check();
  assert.ok(Array.isArray(broken.items), 'a failing health check never breaks the checklist');
});

test('route class: the health routes are admin-only (never member or public)', () => {
  for (const [p, m] of [['/api/system-health', 'GET'], ['/api/system-health/run', 'POST'], ['/api/system-health/settings', 'PUT']]) {
    assert.equal(access.classifyRoute(p, m).kind, 'admin', `${m} ${p}`);
  }
});

test('server.js: the routes go through the handler with the admin check, and the check starts with the backup facts', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(src, /pathname === '\/api\/system-health' \|\| pathname\.startsWith\('\/api\/system-health\/'\)/);
  assert.match(src, /require\('\.\/lib\/system-health\/routes'\)\.handle\(\{\s*\n\s*method: req\.method, pathname, admin: !!req\.hubService \|\| \(access\.isAdmin\(req\.hubUser\) && !req\.hubPendingTotp\)/);
  assert.match(src, /saveSettings: \(v\) => hubSettings\.updateSettings\(\{ systemHealth: v \}\)/);
  assert.match(src, /require\('\.\/lib\/system-health\/wire'\)\.init\(\{[\s\S]{0,1400}?\}\)\.start\(\);/);
});

test('wire.js paths: the folders it measures, and SQLite files in data/ one level down only', () => {
  const W = require(path.join(ISO.lib, 'system-health', 'wire'));
  const p = W.paths();
  const labels = p.disk.map((d) => d.label);
  for (const l of ['install', 'data', 'hub home', 'Claude', 'Codex', 'temp']) assert.ok(labels.includes(l), l);
  for (const l of ['data', 'workspaces', 'backups', 'share', 'Claude projects']) assert.ok(p.bigFolders.some((f) => f.label === l), l);
  fs.mkdirSync(path.join(ISO.data, 'sub', 'deeper'), { recursive: true });
  for (const f of ['a.db', 'a.db-wal', 'a.db-shm', 'b.sqlite', 'notes.txt', 'sub/c.db', 'sub/deeper/d.db']) fs.writeFileSync(path.join(ISO.data, f), '');
  const dbs = W.databases().map((f) => path.relative(ISO.data, f));
  for (const f of ['a.db', 'b.sqlite', path.join('sub', 'c.db')]) assert.ok(dbs.includes(f), f);
  for (const f of ['a.db-wal', 'a.db-shm', 'notes.txt', path.join('sub', 'deeper', 'd.db')]) assert.ok(!dbs.includes(f), f);
  W.init({ backupFolders: () => ['/backups/one', '/backups/two'] });
  assert.deepEqual(W.paths().disk.filter((d) => /^backup folder/.test(d.label)).map((d) => d.label), ['backup folder 1', 'backup folder 2']);
});
