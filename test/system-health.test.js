'use strict';
// The system health check: judging, state, notices, scheduling. Fake probes (the Part A interface), a fake clock, a temp state file.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSystemHealth, validateSettings, DEFAULTS } = require('../lib/system-health');
const { createScheduler } = require('../lib/selfcheck/schedule');

const GB = 1024 ** 3, MIN = 60000, HOUR = 3600000, DAY = 86400000;
const T0 = Date.parse('2026-11-17T12:00:00Z');   // 07:00 in New York

function make(over = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'health-test-'));
  const stateFile = path.join(dir, 'system-health.json');
  const clock = { now: T0 };
  const logs = [];
  const notices = [];
  const cfg = {
    fs: { key: 'data+workspaces', labels: ['data', 'workspaces'], paths: ['/x'], totalBytes: 200 * GB, availBytes: 100 * GB, availPct: 50, inodesTotal: 1000, inodesFree: 900, inodesFreePct: 90, via: 'statfs' },
    diskErrors: [],
    memory: { totalBytes: 16 * GB, availableBytes: 8 * GB, swapTotalBytes: 4 * GB, swapUsedBytes: 0, via: 'linux' },
    clock: { synced: true, how: 'x' },
    db: { ok: true, result: 'ok', bytes: 5 * 1024 * 1024 },
    folders: [{ label: 'data', path: '/d', bytes: 12 * GB }, { label: 'workspaces', path: '/w', bytes: 3.4 * GB }, { label: 'logs', path: '/l', bytes: 1 * GB }, { label: 'cache', path: '/c', bytes: 2 * GB }, { label: 'tmp', path: '/t', bytes: 0.5 * GB }, { label: 'misc', path: '/m', bytes: 0.1 * GB }, { label: 'gone', path: '/g', bytes: null }],
    logSizes: [{ path: '/logs/a.log', bytes: 5 * 1024 * 1024 }],
    backup: { enabled: true, lastOkAt: new Date(T0 - 2 * HOUR).toISOString() },
    signIns: [{ id: 'claude', name: 'Claude', agents: 2, signedIn: true }],
    models: { installed: false, answers: null },
    settings: {}, notifyFails: 0,
    paths: { disk: [{ label: 'data', path: '/d' }], bigFolders: [{ label: 'data', path: '/d' }], databases: ['/data/auth.db'], logs: ['/logs/a.log'] },
    throws: {}, hangs: {},
  };
  const calls = { folderSizes: 0, dbCheck: 0, disk: 0 };
  const maybe = async (name) => { if (cfg.throws[name]) throw new Error(`${name} broke`); if (cfg.hangs[name]) await new Promise(() => {}); };
  const probes = {
    disk: async () => { calls.disk++; await maybe('disk'); return { filesystems: cfg.fs ? [cfg.fs] : [], errors: cfg.diskErrors }; },
    folderSizes: async () => { calls.folderSizes++; await maybe('folderSizes'); return cfg.folders; },
    memory: async () => { await maybe('memory'); return cfg.memory; },
    clock: async () => { await maybe('clock'); return cfg.clock; },
    dbCheck: async () => { calls.dbCheck++; await maybe('dbCheck'); return cfg.db; },
    fileSizes: async () => { await maybe('fileSizes'); return cfg.logSizes; },
  };
  const sh = createSystemHealth({
    probes, stateFile, now: () => clock.now, zone: () => 'America/New_York', settings: () => cfg.settings,
    paths: () => cfg.paths, backupState: () => cfg.backup,
    signIns: async () => { await maybe('signIns'); return cfg.signIns; },
    localModels: async () => { await maybe('localModels'); return cfg.models; },
    notify: async (payload, opts) => { if (cfg.notifyFails > 0) { cfg.notifyFails--; throw new Error('push down'); } notices.push({ payload, opts }); return { sent: 1 }; },
    log: (m) => logs.push(m), limitMs: over.limitMs || 2000,
  });
  return { sh, cfg, clock, stateFile, dir, logs, notices, calls, probes };
}
const item = (v, id) => v.items.find(i => i.id === id);
const raw = (h) => JSON.parse(fs.readFileSync(h.stateFile, 'utf8'));
const nightly = (h) => h.sh.run({ trigger: 'nightly', full: true });
const manual = (h, full = true) => h.sh.run({ trigger: 'manual', full });
const setFree = (h, pct, bytes) => { h.cfg.fs = { ...h.cfg.fs, availPct: pct, availBytes: bytes }; };
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
const DISK = 'health-disk-data+workspaces';

// ── settings ──
test('validateSettings: defaults, unknown keys, ranges, orderings, notify values', () => {
  assert.deepStrictEqual(validateSettings({}).value, { ...DEFAULTS });
  assert.deepStrictEqual(Object.keys(DEFAULTS).length, 16);
  assert.strictEqual(DEFAULTS.clearMarginPct, 2); assert.strictEqual(DEFAULTS.clearMarginGB, 2);
  assert.strictEqual(validateSettings({ clearMarginPct: 51 }).ok, false);
  assert.strictEqual(validateSettings({ clearMarginGB: -1 }).ok, false);
  assert.strictEqual(validateSettings({ clearMarginPct: 0, clearMarginGB: 0 }).ok, true);
  assert.strictEqual(validateSettings({ bogus: 1 }).ok, false);
  assert.strictEqual(validateSettings({ checkAt: '25:00' }).ok, false);
  assert.strictEqual(validateSettings({ checkAt: '3:15' }).ok, false);
  assert.strictEqual(validateSettings({ checkAt: '23:59' }).ok, true);
  assert.strictEqual(validateSettings({ diskWarnPct: 101 }).ok, false);
  assert.strictEqual(validateSettings({ diskWarnPct: 100 }).ok, true);
  assert.strictEqual(validateSettings({ diskCritPct: -1 }).ok, false);
  assert.strictEqual(validateSettings({ diskWarnGB: 100001 }).ok, false);
  assert.strictEqual(validateSettings({ diskCritPct: 16 }).ok, false, 'crit above warn');
  assert.strictEqual(validateSettings({ diskCritGB: 21 }).ok, false);
  assert.strictEqual(validateSettings({ inodeCritPct: 11 }).ok, false);
  assert.strictEqual(validateSettings({ backupCritHours: 35 }).ok, false, 'crit hours below warn hours');
  assert.strictEqual(validateSettings({ backupWarnHours: 0 }).ok, false);
  assert.strictEqual(validateSettings({ backupCritHours: 1001 }).ok, false);
  assert.strictEqual(validateSettings({ fullInDays: 0 }).ok, false);
  assert.strictEqual(validateSettings({ fullInDays: 365 }).ok, true);
  assert.strictEqual(validateSettings({ warnNights: 31 }).ok, false);
  assert.strictEqual(validateSettings({ warnNights: 1 }).ok, true);
  assert.strictEqual(validateSettings({ notify: 'always' }).ok, false);
  for (const n of ['critical', 'warnings', 'off']) assert.strictEqual(validateSettings({ notify: n }).ok, true);
  assert.strictEqual(validateSettings({ enabled: 'yes' }).ok, false);
  assert.strictEqual(validateSettings(null).ok, false);
  assert.strictEqual(validateSettings([]).ok, false);
});

test('settings(): missing keys are defaults; a bad value falls back for that key only', () => {
  const h = make();
  h.cfg.settings = { checkAt: '04:00', diskWarnPct: 'lots' };
  const s = h.sh.settings();
  assert.strictEqual(s.checkAt, '04:00');
  assert.strictEqual(s.diskWarnPct, DEFAULTS.diskWarnPct);
});

// ── disk ──
test('disk: thresholds at the edges (percent and GB, critical and warn)', async () => {
  // each edge on a fresh install: a problem already known holds its level within the clearing margin (tested below)
  const lv = async (pct, bytes) => { const h = make(); setFree(h, pct, bytes); return item(await manual(h), DISK).level; };
  assert.strictEqual(await lv(50, 100 * GB), 'ok');
  assert.strictEqual(await lv(5, 100 * GB), 'warn', 'exactly the critical percent is not critical');
  assert.strictEqual(await lv(4.99, 100 * GB), 'critical');
  assert.strictEqual(await lv(50, 5 * GB), 'warn', 'exactly 5 GB is not critical');
  assert.strictEqual(await lv(50, 5 * GB - 1), 'critical');
  assert.strictEqual(await lv(15, 100 * GB), 'ok', 'exactly the warn percent is fine');
  assert.strictEqual(await lv(14.9, 100 * GB), 'warn');
  assert.strictEqual(await lv(50, 20 * GB), 'ok');
  assert.strictEqual(await lv(50, 20 * GB - 1), 'warn');
});

test('disk: title, folders in the detail, a fix; thresholds come from settings', async () => {
  const h = make();
  setFree(h, 2, 3.1 * GB);
  const it = item(await manual(h), DISK);
  assert.strictEqual(it.level, 'critical');
  assert.strictEqual(it.title, 'Disk almost full: 3.1 GB free (2%)');
  assert.match(it.detail, /Folders on it: data, workspaces/);
  assert.match(it.fix, /data, workspaces/);
  const h2 = make(); setFree(h2, 2, 3.1 * GB);
  h2.cfg.settings = { diskCritPct: 1, diskCritGB: 1, diskWarnPct: 3, diskWarnGB: 4 };
  assert.strictEqual(item(await manual(h2), DISK).level, 'warn');
});

test('disk: a problem on a full run lists the 5 largest folders; a partial run, or no problem, does not look', async () => {
  const h = make();
  setFree(h, 2, 3 * GB);
  const it = item(await manual(h, true), DISK);
  assert.strictEqual(h.calls.folderSizes, 1);
  assert.match(it.detail, /Largest: data 12\.0 GB, workspaces 3\.4 GB, cache 2\.0 GB, logs 1\.0 GB, tmp 512 MB\./);
  assert.doesNotMatch(it.detail, /misc|gone/);
  await manual(h, false);
  assert.strictEqual(h.calls.folderSizes, 1, 'a partial run does not measure folders');
  setFree(h, 50, 100 * GB);
  await manual(h, true);
  assert.strictEqual(h.calls.folderSizes, 1, 'a healthy disk is not walked');
});

test('disk: a folder-size failure does not hide the disk problem', async () => {
  const h = make();
  setFree(h, 2, 3 * GB); h.cfg.throws.folderSizes = true;
  const it = item(await manual(h), DISK);
  assert.strictEqual(it.level, 'critical');
  assert.doesNotMatch(it.detail, /Largest/);
});

test('disk: growth estimate over the last 7 days makes a roomy disk a warning', async () => {
  const h = make();
  setFree(h, 50, 100 * GB); await manual(h);
  h.clock.now += 5 * DAY; setFree(h, 50, 50 * GB);
  let it = item(await manual(h), DISK);
  assert.strictEqual(it.level, 'warn');
  assert.match(it.detail, /At the last 7 days' rate, full in about 5 days/);
  // slower growth: 45 days left, beyond fullInDays (14)
  const g = make();
  setFree(g, 50, 100 * GB); await manual(g);
  g.clock.now += 5 * DAY; setFree(g, 50, 90 * GB);
  assert.strictEqual(item(await manual(g), DISK).level, 'ok');
  g.cfg.settings = { fullInDays: 50 };
  assert.strictEqual(item(await manual(g), DISK).level, 'warn', 'fullInDays is a setting');
  // growing disk space (a clean-up) never warns
  const k = make();
  setFree(k, 50, 50 * GB); await manual(k);
  k.clock.now += 3 * DAY; setFree(k, 50, 100 * GB);
  assert.strictEqual(item(await manual(k), DISK).level, 'ok');
});

test('disk: growth needs readings 2 days apart, from the last 7 days; one reading per local date', async () => {
  const a = make();
  setFree(a, 50, 100 * GB); await manual(a);
  a.clock.now += DAY; setFree(a, 50, 30 * GB);
  assert.strictEqual(item(await manual(a), DISK).level, 'ok', 'only 1 day apart');
  // the only older reading is 10 days back: not within the last 7 days
  const b = make();
  setFree(b, 50, 100 * GB); await manual(b);
  b.clock.now += 10 * DAY; setFree(b, 50, 30 * GB);
  assert.strictEqual(item(await manual(b), DISK).level, 'ok');
  // several runs on one date keep one reading; the day's last value wins
  const c = make();
  setFree(c, 50, 100 * GB); await manual(c);
  c.clock.now += 60000; setFree(c, 50, 99 * GB); await manual(c);
  assert.deepStrictEqual(raw(c).readings.disk['data+workspaces'], [{ date: '2026-11-17', availBytes: 99 * GB }]);
  // 30 days kept
  c.clock.now += 40 * DAY; await manual(c);
  assert.deepStrictEqual(raw(c).readings.disk['data+workspaces'].map(r => r.date), ['2026-12-27']);
});

test('disk: the local date uses the zone (a run at 23:30 and one at 00:30 New York are two dates)', async () => {
  const h = make();
  h.clock.now = Date.parse('2026-11-18T04:30:00Z');   // 23:30 on the 17th
  await manual(h);
  h.clock.now += HOUR;                                 // 00:30 on the 18th
  await manual(h);
  assert.deepStrictEqual(raw(h).readings.disk['data+workspaces'].map(r => r.date), ['2026-11-17', '2026-11-18']);
});

test('disk: a path error becomes unknown, never ok', async () => {
  const h = make();
  h.cfg.diskErrors = [{ label: 'data', path: '/d', error: 'EACCES' }];
  const v = await manual(h);
  assert.strictEqual(item(v, 'health-disk-error-data').level, 'unknown');
});

// ── inodes ──
test('inodes: its own item per filesystem; edges; null means no item', async () => {
  const h = make();
  const lv = async (p) => { h.cfg.fs = { ...h.cfg.fs, inodesFreePct: p }; return item(await manual(h), 'health-inodes-data+workspaces'); };
  assert.strictEqual((await lv(10)).level, 'ok');
  assert.strictEqual((await lv(9.9)).level, 'warn');
  assert.strictEqual((await lv(3)).level, 'warn');
  assert.strictEqual((await lv(2.9)).level, 'critical');
  assert.match((await lv(2.9)).title, /file slots/);
  const g = make();   // no earlier problem: null means no item
  g.cfg.fs = { ...g.cfg.fs, inodesFreePct: null, inodesFree: null, inodesTotal: null };
  assert.strictEqual(item(await manual(g), 'health-inodes-data+workspaces'), undefined);
});

test('inodes: a notified problem whose numbers do not come back is unknown, not "fixed"', async () => {
  const h = make();
  const IN = 'health-inodes-data+workspaces';
  h.cfg.fs = { ...h.cfg.fs, inodesFreePct: 1 };
  let v = await manual(h);
  assert.strictEqual(item(v, IN).level, 'critical');
  assert.strictEqual(h.notices.length, 1);
  h.cfg.fs = { ...h.cfg.fs, inodesFreePct: null, inodesFree: null, inodesTotal: null };
  v = await manual(h);
  assert.strictEqual(item(v, IN).level, 'unknown');
  assert.strictEqual(h.notices.length, 1, 'no "Health: fixed"');
  assert.ok(!h.notices.some(n => n.payload.title === 'Health: fixed'));
  assert.ok(raw(h).notices[IN], 'the notice stays');
  h.cfg.fs = { ...h.cfg.fs, inodesFreePct: 90 }; h.clock.now += 6 * HOUR;
  await manual(h);
  assert.strictEqual(h.notices.filter(n => n.payload.title === 'Health: fixed').length, 1, 'fixed only once it is measured fine');
});

test('inodes: a notified problem stays when the disk reports neither its size nor its file slots (review r2)', async () => {
  const h = make();
  const IN = 'health-inodes-data+workspaces';
  h.cfg.fs = { ...h.cfg.fs, inodesFreePct: 1 };
  await manual(h);
  assert.strictEqual(h.notices.length, 1);
  h.cfg.fs = { ...h.cfg.fs, totalBytes: 0, availBytes: 0, availPct: null, inodesFreePct: null, inodesFree: null, inodesTotal: null };
  const v = await manual(h);
  assert.strictEqual(item(v, IN).level, 'unknown');
  assert.strictEqual(item(v, DISK).level, 'unknown');
  assert.ok(!h.notices.some(n => n.payload.title === 'Health: fixed'), 'no "Health: fixed"');
  assert.ok(raw(h).notices[IN], 'the notice stays');
});

test('wording (proof): sizes from 1 TB read in TB; a notice with no detail has no empty first line', async () => {
  const h = make();
  setFree(h, 2, 1.5 * 1024 * GB);
  h.cfg.settings = { diskCritGB: 100000, diskWarnGB: 100000 };
  assert.strictEqual(item(await manual(h), DISK).title, 'Disk almost full: 1.5 TB free (2%)');
  const h2 = make();
  h2.cfg.signIns = [{ id: 'claude', name: 'Claude', agents: 1, signedIn: false }];
  await manual(h2);
  const n = h2.notices.find(x => /not signed in/.test(x.payload.title));
  assert.ok(n);
  assert.strictEqual(n.payload.body, 'Open Settings and sign in to Claude again.');
});

test('logs: a log it can\'t read is "couldn\'t check" from the first look, never "normal size" (review r2)', async () => {
  const h = make();
  h.cfg.logSizes = [{ path: '/logs/a.log', bytes: null, error: 'EACCES' }];
  const it = item(await manual(h), 'health-logs');
  assert.strictEqual(it.level, 'unknown');
  assert.match(it.detail, /a\.log couldn't be read/);
  h.cfg.logSizes = [{ path: '/logs/a.log', bytes: null, missing: true }];
  assert.strictEqual(item(await manual(h), 'health-logs').level, 'ok', 'a log that is not there is fine');
});

test('clock: a notified problem then "synced null" is unknown, not fixed; with no notice it is info', async () => {
  const h = make();
  h.cfg.settings = { notify: 'warnings', warnNights: 1 }; h.cfg.backup = null;
  h.cfg.clock = { synced: false, how: 'x' };
  await nightly(h);
  assert.strictEqual(h.notices.length, 1);
  h.cfg.clock = { synced: null, how: 'x' };
  h.clock.now += DAY;
  const v = await nightly(h);
  assert.strictEqual(item(v, 'health-clock').level, 'unknown');
  assert.strictEqual(h.notices.length, 1, 'no "Health: fixed"');
  assert.ok(raw(h).notices['health-clock']);
  const g = make(); g.cfg.clock = { synced: null, how: 'x' };
  assert.strictEqual(item(await manual(g), 'health-clock').level, 'info');
});

test('logs: a notified big log that cannot be read is unknown, not fixed; one that is missing is fixed', async () => {
  const h = make();
  h.cfg.logSizes = [{ path: '/logs/a.log', bytes: 1.5 * GB }];
  assert.strictEqual(item(await manual(h), 'health-logs').level, 'warn');
  h.cfg.settings = { notify: 'warnings', warnNights: 1 };
  await nightly(h);
  assert.strictEqual(h.notices.length, 1, 'the warning was notified');
  h.cfg.logSizes = [{ path: '/logs/a.log', bytes: null, error: 'EACCES' }];
  let v = await manual(h);
  assert.strictEqual(item(v, 'health-logs').level, 'unknown');
  assert.strictEqual(h.notices.length, 1, 'no "Health: fixed"');
  assert.ok(raw(h).notices['health-logs']);
  h.cfg.logSizes = [{ path: '/logs/a.log', bytes: null, missing: true }]; h.clock.now += 6 * HOUR;
  v = await manual(h);
  assert.strictEqual(item(v, 'health-logs').level, 'ok');
  assert.strictEqual(h.notices.length, 2);
  assert.strictEqual(h.notices[1].payload.title, 'Health: fixed');
  await manual(h);
  assert.strictEqual(h.notices.length, 2, 'one fixed notice only');
});

// ── databases named { file, name } ──
test('databases: { file, name } entries are told apart by name; a plain path still uses its basename; no flapping', async () => {
  const h = make();
  h.cfg.paths = { ...h.cfg.paths, databases: [{ file: '/data/a/cache.db', name: 'a/cache.db' }, { file: '/data/b/cache.db', name: 'b/cache.db' }] };
  h.probes.dbCheck = async (f) => (f === '/data/a/cache.db' ? { ok: false, result: 'row 3 is bad', bytes: 10 } : { ok: true, result: 'ok', bytes: 10 });
  let v = await manual(h);
  assert.strictEqual(item(v, 'health-db-a/cache.db').level, 'critical');
  assert.strictEqual(item(v, 'health-db-b/cache.db').level, 'ok');
  assert.strictEqual(v.items.filter(i => i.check === 'db').length, 2);
  assert.strictEqual(h.notices.length, 1);
  v = await manual(h);
  assert.strictEqual(h.notices.length, 1, 'no second notice and no "fixed"');
  assert.strictEqual(item(v, 'health-db-a/cache.db').level, 'critical');
  const p = make();
  p.cfg.paths = { ...p.cfg.paths, databases: ['/data/x/plain.db'] };
  assert.ok(item(await manual(p), 'health-db-plain.db'));
});

// ── start() arms the scheduler and sampler even when disabled ──
test('start() with enabled false still arms the nightly run: enabling later runs it at checkAt', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const h = make(); h.cfg.settings = { enabled: false, afterStart: false, checkAt: '03:15' };
  fs.writeFileSync(h.stateFile, JSON.stringify({ lastFullRun: { startedAt: new Date(T0 - 5 * HOUR).toISOString(), finishedAt: null, trigger: 'start', full: true } }));
  h.sh.start();
  h.cfg.settings = { enabled: true, afterStart: false, checkAt: '03:15' };
  h.clock.now = Date.parse('2026-11-18T08:16:00Z');   // 03:16 New York
  t.mock.timers.tick(5 * MIN);
  for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r));
  assert.strictEqual(raw(h).lastRun.trigger, 'nightly');
  assert.strictEqual(h.calls.disk, 1);
  h.sh.stop();
});

test('start() with enabled false: the sampler ticks but does not call probes.memory; once enabled it does', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const h = make(); h.cfg.settings = { enabled: false };
  let mem = 0;
  h.probes.memory = async () => { mem++; return h.cfg.memory; };
  h.sh.start();
  t.mock.timers.tick(10 * MIN); await new Promise(r => setImmediate(r));
  assert.strictEqual(mem, 0);
  h.cfg.settings = { enabled: true };
  t.mock.timers.tick(5 * MIN); await new Promise(r => setImmediate(r));
  assert.strictEqual(mem, 1);
  h.sh.stop();
});

// ── memory ──
test('memory: swap 80% used with 60% of memory available is not heavy; with 20% available it is; 5% available alone is', async () => {
  const lv = async (mem) => { const h = make(); h.cfg.memory = { totalBytes: 100, availableBytes: 50, swapTotalBytes: null, swapUsedBytes: null, ...mem }; for (let i = 0; i < 6; i++) { await h.sh.sampleMemory(); h.clock.now += MIN; } return item(await manual(h), 'health-memory').level; };
  assert.strictEqual(await lv({ availableBytes: 60, swapTotalBytes: 10, swapUsedBytes: 8 }), 'ok');
  assert.strictEqual(await lv({ availableBytes: 20, swapTotalBytes: 10, swapUsedBytes: 8 }), 'warn');
  assert.strictEqual(await lv({ availableBytes: 5 }), 'warn');
});

test('memory: sustained = 5 samples in 30 minutes, all heavy; never critical', async () => {
  const h = make();
  const heavySwap = { totalBytes: 16 * GB, availableBytes: 2 * GB, swapTotalBytes: 10 * GB, swapUsedBytes: 5 * GB };
  h.cfg.memory = heavySwap;
  for (let i = 0; i < 4; i++) { await h.sh.sampleMemory(); h.clock.now += 5 * MIN; }
  assert.strictEqual(item(await manual(h), 'health-memory').level, 'ok', 'only 4 samples');
  await h.sh.sampleMemory();
  const it = item(await manual(h), 'health-memory');
  assert.strictEqual(it.level, 'warn');
  assert.notStrictEqual(it.level, 'critical');
  // one light sample among the last five
  const g = make();
  g.cfg.memory = heavySwap;
  for (let i = 0; i < 5; i++) { if (i === 2) g.cfg.memory = { ...heavySwap, swapUsedBytes: 4.9 * GB }; else g.cfg.memory = { ...heavySwap }; await g.sh.sampleMemory(); g.clock.now += 5 * MIN; }
  assert.strictEqual(item(await manual(g), 'health-memory').level, 'ok');
});

test('memory: heavy means swap >= 50% (swap total > 0) or available < 10% of total', async () => {
  const lv = async (mem) => { const h = make(); h.cfg.memory = { totalBytes: 100, availableBytes: 50, swapTotalBytes: null, swapUsedBytes: null, ...mem }; for (let i = 0; i < 5; i++) { await h.sh.sampleMemory(); h.clock.now += MIN; } return item(await manual(h), 'health-memory').level; };
  assert.strictEqual(await lv({ availableBytes: 9 }), 'warn');
  assert.strictEqual(await lv({ availableBytes: 10 }), 'ok', 'exactly 10% is not heavy');
  assert.strictEqual(await lv({ availableBytes: 20, swapTotalBytes: 10, swapUsedBytes: 5 }), 'warn');
  assert.strictEqual(await lv({ swapTotalBytes: 10, swapUsedBytes: 5 }), 'ok', 'swap half used on a roomy machine is not heavy');
  assert.strictEqual(await lv({ swapTotalBytes: 10, swapUsedBytes: 4 }), 'ok');
  assert.strictEqual(await lv({ swapTotalBytes: 0, swapUsedBytes: 0 }), 'ok', 'no swap at all is not heavy');
});

test('memory: samples older than 30 minutes do not count', async () => {
  const h = make();
  h.cfg.memory = { totalBytes: 100, availableBytes: 5, swapTotalBytes: null, swapUsedBytes: null };
  for (let i = 0; i < 5; i++) { await h.sh.sampleMemory(); h.clock.now += 5 * MIN; }
  assert.strictEqual(item(await manual(h), 'health-memory').level, 'warn');
  h.clock.now += 20 * MIN;   // the samples are now 25-45 minutes old
  assert.strictEqual(item(await manual(h), 'health-memory').level, 'ok');
});

test('memory: start() samples every 5 minutes', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const h = make(); h.cfg.settings = { afterStart: false };
  h.cfg.memory = { totalBytes: 100, availableBytes: 5, swapTotalBytes: null, swapUsedBytes: null };
  h.sh.start();
  for (let i = 0; i < 5; i++) { t.mock.timers.tick(5 * MIN); h.clock.now += 5 * MIN; await new Promise(r => setImmediate(r)); }
  assert.strictEqual(item(await manual(h), 'health-memory').level, 'warn');
  h.sh.stop();
});

// ── unknown ──
test('a probe that throws or hangs gives unknown, titled "<what> couldn\'t be checked", never ok', async () => {
  const h = make({ limitMs: 60 });
  h.cfg.throws.disk = true; h.cfg.hangs.clock = true; h.cfg.throws.memory = true; h.cfg.hangs.signIns = true;
  h.cfg.throws.fileSizes = true; h.cfg.hangs.dbCheck = true; h.cfg.throws.localModels = true;
  const v = await manual(h);
  for (const [id, title] of [['health-disk', 'Disk space'], ['health-clock', 'The clock'], ['health-memory', 'Memory'], ['health-signin', 'Sign-ins'], ['health-logs', 'The log files'], ['health-db-auth.db', 'The auth.db database'], ['health-local-models', 'The local models']]) {
    const it = item(v, id);
    assert.ok(it, id);
    assert.strictEqual(it.level, 'unknown', id);
    assert.strictEqual(it.title, `${title} couldn't be checked`);
  }
  assert.match(item(v, 'health-clock').detail, /ran out of time/);
  assert.match(item(v, 'health-disk').detail, /disk broke/);
  assert.strictEqual(v.critical + v.warnings, 0);
});

// ── databases ──
test('databases: damaged is critical, null is unknown, ok shows size and 7-day growth', async () => {
  const h = make();
  h.cfg.db = { ok: false, result: 'row 4 missing', bytes: 10 };
  let it = item(await manual(h), 'health-db-auth.db');
  assert.strictEqual(it.level, 'critical');
  assert.strictEqual(it.title, 'A database is damaged: auth.db');
  assert.match(it.detail, /row 4 missing/);
  h.cfg.db = { ok: null, result: 'busy', bytes: null };
  assert.strictEqual(item(await manual(h), 'health-db-auth.db').level, 'unknown');
  h.cfg.db = { ok: true, result: 'ok', bytes: 100 * 1024 * 1024 };
  await manual(h);
  h.clock.now += 4 * DAY;
  h.cfg.db = { ok: true, result: 'ok', bytes: 130 * 1024 * 1024 };
  it = item(await manual(h), 'health-db-auth.db');
  assert.strictEqual(it.level, 'ok');
  assert.match(it.detail, /Size 130 MB\./);
  assert.match(it.detail, /Grew 30 MB in the last 4 days/);
});

test('databases: a partial run does not run the checks', async () => {
  const h = make();
  await manual(h, false);
  assert.strictEqual(h.calls.dbCheck, 0);
  assert.strictEqual(item(h.sh.view(), 'health-db-auth.db'), undefined);
});

// ── backups ──
test('backups: null = no item; off = info; warn and critical at the hours (edges)', async () => {
  const h = make();
  h.cfg.backup = null;
  assert.strictEqual(item(await manual(h), 'health-backups'), undefined);
  h.cfg.backup = { enabled: false, lastOkAt: null };
  let it = item(await manual(h), 'health-backups');
  assert.strictEqual(it.level, 'info'); assert.strictEqual(it.title, 'Nightly backups are off');
  const lv = async (hours) => { h.cfg.backup = { enabled: true, lastOkAt: new Date(h.clock.now - hours * HOUR).toISOString() }; return item(await manual(h), 'health-backups').level; };
  assert.strictEqual(await lv(35.9), 'ok');
  assert.strictEqual(await lv(36), 'warn');
  assert.strictEqual(await lv(71.9), 'warn');
  assert.strictEqual(await lv(72), 'critical');
  h.cfg.backup = { enabled: true, lastOkAt: null };
  assert.strictEqual(item(await manual(h), 'health-backups').level, 'critical', 'no backup ever, and no set-up time known');
  // no backup yet: the wait counts from when backups were set up, so a fresh setup is no alarm before its first night
  const fresh = async (hours) => { h.cfg.backup = { enabled: true, lastOkAt: null, setUpAt: new Date(h.clock.now - hours * HOUR).toISOString() }; return item(await manual(h), 'health-backups'); };
  assert.strictEqual((await fresh(2)).level, 'ok', 'set up 2 hours ago');
  const old = await fresh(40);
  assert.strictEqual(old.level, 'warn');
  assert.match(old.title, /^No backup has finished in the 40 hours since backups were set up$/);
  assert.strictEqual((await fresh(80)).level, 'critical');
  h.cfg.settings = { backupWarnHours: 10, backupCritHours: 20 };
  assert.strictEqual(await lv(10), 'warn');
});

test('a disk that reports no size is "couldn\'t check", never full', async () => {
  const h = make();
  h.cfg.fs = { ...h.cfg.fs, totalBytes: 0, availBytes: 0, availPct: null };
  const it = item(await manual(h), DISK);
  assert.strictEqual(it.level, 'unknown');
  assert.strictEqual(h.notices.length, 0);
});

// ── sign-ins ──
test('sign-ins: not signed in is critical with the agent count; null unknown; zero agents no item', async () => {
  const h = make();
  h.cfg.signIns = [
    { id: 'claude', name: 'Claude', agents: 3, signedIn: false },
    { id: 'codex', name: 'ChatGPT (Codex)', agents: 1, signedIn: null },
    { id: 'other', name: 'Other', agents: 0, signedIn: false },
  ];
  const v = await manual(h, false);
  assert.strictEqual(item(v, 'health-signin-claude').level, 'critical');
  assert.strictEqual(item(v, 'health-signin-claude').title, "Claude is not signed in: 3 agents can't answer");
  assert.strictEqual(item(v, 'health-signin-codex').level, 'unknown');
  assert.strictEqual(item(v, 'health-signin-other'), undefined);
  h.cfg.signIns = [{ id: 'claude', name: 'Claude', agents: 1, signedIn: false }];
  assert.strictEqual(item(await manual(h, false), 'health-signin-claude').title, "Claude is not signed in: 1 agent can't answer");
  h.cfg.signIns = [{ id: 'claude', name: 'Claude', agents: 1, signedIn: true }];
  assert.strictEqual(item(await manual(h, false), 'health-signin-claude').level, 'ok');
});

// ── restarts ──
test('restarts: start() records the start; 6 in 24 hours warn, 20 critical (counting this one)', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const lv = async (before) => {
    const h = make(); h.cfg.settings = { afterStart: false };
    fs.writeFileSync(h.stateFile, JSON.stringify({ starts: Array.from({ length: before }, (_, i) => T0 - (i + 1) * MIN) }));
    h.sh.start(); h.sh.stop();
    const it = item(await manual(h), 'health-restarts');
    return it;
  };
  assert.strictEqual((await lv(4)).level, 'ok');          // 5 with this one
  assert.strictEqual((await lv(5)).level, 'warn');        // 6
  assert.strictEqual((await lv(18)).level, 'warn');       // 19
  const c = await lv(19);                                 // 20
  assert.strictEqual(c.level, 'critical');
  assert.strictEqual(c.title, 'Your Maestro restarted 20 times in the last 24 hours');
});

test('restarts: only the last 24 hours count; starts older than 7 days are dropped from the state', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const h = make(); h.cfg.settings = { afterStart: false };
  fs.writeFileSync(h.stateFile, JSON.stringify({ starts: [T0 - 8 * DAY, T0 - 3 * DAY, ...Array.from({ length: 5 }, (_, i) => T0 - 25 * HOUR - i)] }));
  h.sh.start(); h.sh.stop();
  assert.strictEqual(raw(h).starts.length, 7, 'the 8-day-old start is gone');
  const it = item(await manual(h), 'health-restarts');
  assert.strictEqual(it.level, 'ok');
  assert.strictEqual(it.title, 'Your Maestro restarted 1 time in the last 24 hours');
});

// ── logs, clock, models ──
test('logs: a file over 1 GB warns naming it; exactly 1 GB does not', async () => {
  const h = make();
  h.cfg.logSizes = [{ path: '/logs/a.log', bytes: GB }, { path: '/logs/b.log', bytes: 10 }];
  assert.strictEqual(item(await manual(h), 'health-logs').level, 'ok');
  h.cfg.logSizes = [{ path: '/logs/a.log', bytes: 1.5 * GB }, { path: '/logs/b.log', bytes: 10 }, { path: '/logs/c.log', bytes: null }];
  const it = item(await manual(h), 'health-logs');
  assert.strictEqual(it.level, 'warn');
  assert.match(it.title, /a\.log 1\.5 GB/);
});

test('clock: not synced warns; null is info with its words; synced ok', async () => {
  const h = make();
  h.cfg.clock = { synced: false, how: 'x' };
  assert.strictEqual(item(await manual(h), 'health-clock').level, 'warn');
  h.cfg.clock = { synced: null, how: 'x' };
  assert.strictEqual(item(await manual(h), 'health-clock').level, 'unknown', 'after a warning it is not read as fine');
  const g = make(); g.cfg.clock = { synced: null, how: 'x' };
  const it = item(await manual(g), 'health-clock');
  assert.strictEqual(it.level, 'info'); assert.strictEqual(it.title, "This computer doesn't report clock sync");
  h.cfg.clock = { synced: true, how: 'x' };
  assert.strictEqual(item(await manual(h), 'health-clock').level, 'ok');
});

test('local models: not installed no item; not answering warn; null unknown', async () => {
  const h = make();
  assert.strictEqual(item(await manual(h), 'health-local-models'), undefined);
  h.cfg.models = { installed: true, answers: false };
  assert.strictEqual(item(await manual(h), 'health-local-models').level, 'warn');
  h.cfg.models = { installed: true, answers: null };
  assert.strictEqual(item(await manual(h), 'health-local-models').level, 'unknown');
  h.cfg.models = { installed: true, answers: true };
  assert.strictEqual(item(await manual(h), 'health-local-models').level, 'ok');
});

// ── partial runs ──
test('a partial run measures only disk, inodes, memory and sign-ins; the rest keep their last values', async () => {
  const h = make();
  h.cfg.db = { ok: false, result: 'bad', bytes: 1 };
  h.cfg.clock = { synced: false, how: 'x' };
  h.cfg.backup = { enabled: true, lastOkAt: null };
  await manual(h, true);
  h.cfg.db = { ok: true, result: 'ok', bytes: 1 };
  h.cfg.clock = { synced: true, how: 'x' };
  setFree(h, 2, 3 * GB);
  h.cfg.signIns = [{ id: 'claude', name: 'Claude', agents: 1, signedIn: false }];
  const v = await manual(h, false);
  assert.strictEqual(item(v, 'health-db-auth.db').level, 'critical', 'database not re-checked');
  assert.strictEqual(item(v, 'health-clock').level, 'warn');
  assert.strictEqual(item(v, 'health-backups').level, 'critical');
  assert.strictEqual(item(v, DISK).level, 'critical', 'disk is measured');
  assert.strictEqual(item(v, 'health-signin-claude').level, 'critical');
  assert.strictEqual(v.lastRun.full, false);
  assert.strictEqual(raw(h).lastFullRun.full, true, 'lastFullRun stays the full one');
  assert.strictEqual(h.calls.dbCheck, 1);
});

test('a partial run with no earlier state has only the cheap items', async () => {
  const h = make();
  const v = await manual(h, false);
  // 'code' joined the cheap items on purpose (changed own files are looked for on quick runs too); with no codeChanges dep it reads "not a git checkout"
  assert.deepStrictEqual(v.items.map(i => i.check).sort(), ['code', 'disk', 'inodes', 'memory', 'signin']);
  assert.strictEqual(raw(h).lastFullRun, null);
});

// ── run control ──
test('one run at a time; disabled leaves the view unchanged', async () => {
  const h = make();
  const a = h.sh.run({ trigger: 'manual' }), b = h.sh.run({ trigger: 'manual' });
  assert.strictEqual(a, b);
  assert.strictEqual(h.sh.isRunning(), true);
  await a;
  assert.strictEqual(h.sh.isRunning(), false);
  assert.strictEqual(h.calls.disk, 1);
  const before = JSON.stringify(h.sh.view());
  h.cfg.settings = { enabled: false };
  const v = await h.sh.run({ trigger: 'manual' });
  assert.strictEqual(h.calls.disk, 1);
  assert.deepStrictEqual(Object.keys(v).sort(), ['critical', 'items', 'lastRun', 'running', 'settings', 'warnings']);
  assert.strictEqual(JSON.stringify({ ...v, settings: 0 }), JSON.stringify({ ...JSON.parse(before), settings: 0 }));
});

test('view(): shape, counts, sorted worst first, notified flag', async () => {
  const h = make();
  setFree(h, 2, 3 * GB); h.cfg.clock = { synced: false, how: 'x' };
  const v = await manual(h);
  assert.strictEqual(v.running, false);
  assert.strictEqual(v.critical, 1); assert.strictEqual(v.warnings, 1);
  assert.strictEqual(v.items[0].level, 'critical');
  assert.deepStrictEqual(Object.keys(v.items[0]).sort(), ['check', 'detail', 'fix', 'id', 'level', 'notified', 'since', 'title']);
  assert.deepStrictEqual(Object.keys(v.lastRun).sort(), ['finishedAt', 'full', 'startedAt', 'trigger']);
  assert.strictEqual(v.items[0].notified, true, 'the default notify mode tells about critical');
  assert.strictEqual(item(v, 'health-clock').notified, false);
});

// ── notices ──
test('critical: one push with the exact payload, then never again (next runs, next nights)', async () => {
  const h = make(); h.cfg.backup = null;
  setFree(h, 2, 3 * GB);
  await nightly(h);
  assert.strictEqual(h.notices.length, 1);
  const { payload, opts } = h.notices[0];
  const it = item(h.sh.view(), DISK);
  assert.strictEqual(payload.title, `Health: ${it.title}`);
  assert.strictEqual(payload.body, `${it.detail}\n${it.fix}`);
  assert.strictEqual(payload.url, '/?health=1');
  assert.strictEqual(payload.tag, `health-${DISK}`);
  assert.deepStrictEqual(opts, { urgency: 'high' });
  assert.strictEqual(raw(h).notices[DISK].notifiedLevel, 'critical');
  await manual(h); h.clock.now += DAY; await nightly(h); h.clock.now += DAY; await nightly(h);
  assert.strictEqual(h.notices.length, 1);
  assert.strictEqual(raw(h).notices[DISK].nights, 3);
});

test('critical: `since` is kept while it stays a problem (also across a restart of the module)', async () => {
  const h = make();
  setFree(h, 2, 3 * GB);
  await manual(h);
  const since = item(h.sh.view(), DISK).since;
  assert.strictEqual(since, new Date(T0).toISOString());
  h.clock.now += 2 * HOUR; await manual(h);
  assert.strictEqual(item(h.sh.view(), DISK).since, since);
});

// ── hysteresis: a reading hovering at a threshold neither flips the level nor flaps the notices ──
// The harness disk is 200 GB: critical under 10 GB (5%), warning under 30 GB (15%), clearing margin max(2% = 4 GB, 2 GB) = 4 GB.
const free = (h, gb) => setFree(h, gb / 200 * 100, gb * GB);
test('hysteresis: a disk hovering at the critical threshold stays critical, is told once, and needs the margin to step down', async () => {
  const h = make();
  const lv = async (gb) => { free(h, gb); return item(await manual(h), DISK).level; };
  assert.strictEqual(await lv(9.8), 'critical');
  assert.strictEqual(await lv(10.2), 'critical', 'just above the threshold: held');
  assert.strictEqual(await lv(9.9), 'critical');
  assert.strictEqual(await lv(13.9), 'critical', 'still inside the 4 GB margin');
  assert.strictEqual(await lv(14.1), 'warn', 'past the margin: down to warning (still under 30 GB)');
  assert.strictEqual(await lv(32), 'warn', 'a warning likewise needs the margin above 30 GB');
  assert.strictEqual(await lv(34.1), 'ok');
  assert.strictEqual(h.notices.length, 1, 'one critical notice, no "fixed" (within 6 hours), nothing for hovering');
  assert.match(h.notices[0].payload.title, /^Health: Disk almost full/);
});

test('hysteresis: a fresh install crossing the threshold with no known problem uses the plain thresholds', async () => {
  const h = make();
  free(h, 10.2);
  assert.strictEqual(item(await manual(h), DISK).level, 'warn');
  assert.strictEqual(h.notices.length, 0);
});

test('hysteresis: margin settings: 0 turns it off; the GB margin wins when larger', async () => {
  const h = make();
  h.cfg.settings = { clearMarginPct: 0, clearMarginGB: 0 };
  free(h, 9.8); await manual(h);
  free(h, 10.2);
  assert.strictEqual(item(await manual(h), DISK).level, 'warn', 'no margin: steps down at once');
  const g = make();
  g.cfg.settings = { clearMarginPct: 0, clearMarginGB: 10 };
  free(g, 9.8); await manual(g);
  free(g, 19.9);
  assert.strictEqual(item(await manual(g), DISK).level, 'critical', '10 GB margin');
  free(g, 20.1);
  assert.strictEqual(item(await manual(g), DISK).level, 'warn');
});

test('hysteresis: file slots hover the same way, by percentage points', async () => {
  const h = make();
  const IN = 'health-inodes-data+workspaces';
  const lv = async (pct) => { h.cfg.fs = { ...h.cfg.fs, inodesFreePct: pct }; return item(await manual(h), IN).level; };
  assert.strictEqual(await lv(2.9), 'critical');
  assert.strictEqual(await lv(3.5), 'critical', 'inside the 2-point margin');
  assert.strictEqual(await lv(5.1), 'warn');
  assert.strictEqual(await lv(11.9), 'warn');
  assert.strictEqual(await lv(12.1), 'ok');
  assert.strictEqual(h.notices.length, 1);
});

test('quiet 6 hours: no "fixed" within 6 hours of the notice; a return meanwhile is not told again; "fixed" after 6 hours', async () => {
  const h = make();
  free(h, 9.8); await manual(h);
  assert.strictEqual(h.notices.length, 1);
  h.clock.now += HOUR; free(h, 100);
  assert.strictEqual(item(await manual(h), DISK).level, 'ok');
  assert.strictEqual(h.notices.length, 1, 'cleared after an hour: no "fixed" yet');
  assert.ok(raw(h).notices[DISK], 'the problem stays open');
  h.clock.now += HOUR; free(h, 9.8);
  assert.strictEqual(item(await manual(h), DISK).level, 'critical');
  assert.strictEqual(h.notices.length, 1, 'back again within 6 hours: the same problem, not told again');
  h.clock.now += 5 * HOUR; free(h, 100);
  await manual(h);
  assert.strictEqual(h.notices.length, 2);
  assert.strictEqual(h.notices[1].payload.title, 'Health: fixed');
  assert.deepStrictEqual(raw(h).notices, {});
});

test('quiet 6 hours: a problem that cleared inside the window and comes back a day later is told again (review r5)', async () => {
  const h = make();
  free(h, 9.8); await manual(h);
  assert.strictEqual(h.notices.length, 1);
  h.clock.now += HOUR; free(h, 100); await manual(h);          // cleared inside the 6 hours: "fixed" held back
  assert.strictEqual(h.notices.length, 1);
  h.clock.now += DAY; free(h, 9.8);                             // back a day later, with no run in between
  assert.strictEqual(item(await manual(h), DISK).level, 'critical');
  assert.strictEqual(h.notices.length, 2, 'a new problem: told again');
  assert.match(h.notices[1].payload.title, /^Health: Disk almost full/);
});

test('quiet 6 hours: a problem that cleared no longer holds the clearing margin (review r5)', async () => {
  const h = make();
  free(h, 9.8); await manual(h);
  h.clock.now += HOUR; free(h, 100); await manual(h);          // cleared, "fixed" held back
  h.clock.now += HOUR; free(h, 12);                             // above 10 GB, inside the old 4 GB margin
  assert.strictEqual(item(await manual(h), DISK).level, 'warn', 'judged on the plain thresholds, not held at critical');
  assert.strictEqual(h.notices.length, 1, 'no new notice: a warning is not worse than what was told');
});

test('quiet 6 hours: getting worse always notifies at once (a notified warning that turns critical)', async () => {
  const h = make();
  h.cfg.settings = { notify: 'warnings', warnNights: 1 };
  free(h, 25); await nightly(h);
  assert.strictEqual(h.notices.length, 1);
  assert.match(h.notices[0].payload.title, /Disk getting full/);
  h.clock.now += 10 * MIN; free(h, 9);
  await manual(h);
  assert.strictEqual(h.notices.length, 2, 'worse: told at once, inside the 6 hours');
  assert.match(h.notices[1].payload.title, /Disk almost full/);
});

test('fixed: one "Health: fixed" naming the old problem after it is notified and goes away; then the entry is gone', async () => {
  const h = make();
  setFree(h, 2, 3 * GB);
  await manual(h);
  const oldTitle = item(h.sh.view(), DISK).title;
  setFree(h, 50, 100 * GB); h.clock.now += 6 * HOUR;
  await manual(h);
  assert.strictEqual(h.notices.length, 2);
  assert.strictEqual(h.notices[1].payload.title, 'Health: fixed');
  assert.strictEqual(h.notices[1].payload.body, `Back to normal: ${oldTitle}.`);
  assert.strictEqual(h.notices[1].payload.url, '/?health=1');
  assert.deepStrictEqual(raw(h).notices, {});
  await manual(h);
  assert.strictEqual(h.notices.length, 2, 'once');
});

test('fixed: also when the item disappears in a run that measured its check; not for an unmeasured check', async () => {
  const h = make();
  h.cfg.models = { installed: true, answers: false };
  h.cfg.settings = { notify: 'warnings', warnNights: 1 };
  await nightly(h);
  assert.strictEqual(h.notices.length, 1);
  // a partial run did not measure local models: the notice stays
  h.cfg.models = { installed: false, answers: null };
  await manual(h, false);
  assert.strictEqual(h.notices.length, 1);
  assert.ok(raw(h).notices['health-local-models']);
  // a full run did (6 hours on): models no longer installed, the item disappears
  h.clock.now += 6 * HOUR;
  await manual(h, true);
  assert.strictEqual(h.notices.length, 2);
  assert.strictEqual(h.notices[1].payload.title, 'Health: fixed');
  assert.match(h.notices[1].payload.body, /^Back to normal: Your local models aren't answering\.$/);
});

test('a problem that was never notified is removed silently', async () => {
  const h = make();
  h.cfg.clock = { synced: false, how: 'x' };   // warn, notify mode critical
  await nightly(h);
  assert.ok(raw(h).notices['health-clock']);
  h.cfg.clock = { synced: true, how: 'x' };
  await manual(h);
  assert.strictEqual(h.notices.length, 0);
  assert.deepStrictEqual(raw(h).notices, {});
});

test('unknown changes nothing: no notice, no "fixed", the notice stays', async () => {
  const h = make();
  setFree(h, 2, 3 * GB);
  await manual(h);
  assert.strictEqual(h.notices.length, 1);
  h.cfg.throws.disk = true;
  const v = await manual(h);
  assert.strictEqual(item(v, 'health-disk').level, 'unknown');
  assert.strictEqual(h.notices.length, 1);
  assert.ok(raw(h).notices[DISK], 'still remembered');
  // when disk is back and still full: no second push
  h.cfg.throws.disk = false;
  await manual(h);
  assert.strictEqual(h.notices.length, 1);
  assert.strictEqual(item(h.sh.view(), DISK).since, new Date(T0).toISOString());
});

test('a notify that rejects is logged and retried at the next run; notifiedLevel is set only on success', async () => {
  const h = make();
  setFree(h, 2, 3 * GB);
  h.cfg.notifyFails = 1;
  await manual(h);
  assert.strictEqual(h.notices.length, 0);
  assert.strictEqual(raw(h).notices[DISK].notifiedLevel, null);
  assert.ok(h.logs.some(l => /push down/.test(l)));
  assert.strictEqual(item(h.sh.view(), DISK).notified, false);
  await manual(h);
  assert.strictEqual(h.notices.length, 1);
  assert.strictEqual(raw(h).notices[DISK].notifiedLevel, 'critical');
  await manual(h);
  assert.strictEqual(h.notices.length, 1);
});

test('a "fixed" notice that fails to send is retried at the next run', async () => {
  const h = make();
  setFree(h, 2, 3 * GB); await manual(h);
  setFree(h, 50, 100 * GB); h.cfg.notifyFails = 1; h.clock.now += 6 * HOUR;
  await manual(h);
  assert.strictEqual(h.notices.length, 1);
  assert.ok(raw(h).notices[DISK], 'kept for the retry');
  await manual(h);
  assert.strictEqual(h.notices.length, 2);
  assert.deepStrictEqual(raw(h).notices, {});
});

test('warnings: only with notify "warnings", only after warnNights nightly runs in a row, once, urgency normal', async () => {
  const h = make();
  h.cfg.settings = { notify: 'warnings', warnNights: 3 }; h.cfg.backup = null;
  h.cfg.clock = { synced: false, how: 'x' };
  await nightly(h);
  await nightly(h);                                   // the same date: still night 1
  await manual(h);                                    // a manual run is not a night
  assert.strictEqual(raw(h).notices['health-clock'].nights, 1);
  h.clock.now += DAY; await nightly(h);
  assert.strictEqual(h.notices.length, 0, 'night 2');
  h.clock.now += DAY; await nightly(h);
  assert.strictEqual(h.notices.length, 1, 'night 3');
  assert.deepStrictEqual(h.notices[0].opts, { urgency: 'normal' });
  assert.strictEqual(h.notices[0].payload.tag, 'health-health-clock');
  assert.strictEqual(raw(h).notices['health-clock'].notifiedLevel, 'warn');
  h.clock.now += DAY; await nightly(h);
  assert.strictEqual(h.notices.length, 1, 'never every night');
});

test('warnings: nights start over when the problem goes away; notify "critical" never sends a warning', async () => {
  const h = make();
  h.cfg.settings = { notify: 'warnings', warnNights: 2 }; h.cfg.backup = null;
  h.cfg.clock = { synced: false, how: 'x' };
  await nightly(h);
  h.cfg.clock = { synced: true, how: 'x' };
  h.clock.now += DAY; await nightly(h);
  h.cfg.clock = { synced: false, how: 'x' };
  h.clock.now += DAY; await nightly(h);
  assert.strictEqual(h.notices.length, 0, 'the streak was broken');
  assert.strictEqual(raw(h).notices['health-clock'].nights, 1);
  const g = make();
  g.cfg.settings = { notify: 'critical', warnNights: 1 }; g.cfg.backup = null;
  g.cfg.clock = { synced: false, how: 'x' };
  for (let i = 0; i < 4; i++) { await nightly(g); g.clock.now += DAY; }
  assert.strictEqual(g.notices.length, 0);
});

test('warn that becomes critical is told as critical (once more), even after a warning push', async () => {
  const h = make();
  h.cfg.settings = { notify: 'warnings', warnNights: 1 };
  setFree(h, 10, 100 * GB);
  await nightly(h);
  assert.strictEqual(h.notices.length, 1); assert.strictEqual(h.notices[0].opts.urgency, 'normal');
  setFree(h, 2, 3 * GB);
  await manual(h);
  assert.strictEqual(h.notices.length, 2); assert.strictEqual(h.notices[1].opts.urgency, 'high');
  setFree(h, 10, 100 * GB);
  await manual(h);
  assert.strictEqual(h.notices.length, 2, 'critical back to warn: nothing new');
});

test('notify "off" sends nothing, not even "fixed"', async () => {
  const h = make();
  h.cfg.settings = { notify: 'off', warnNights: 1 };
  setFree(h, 2, 3 * GB);
  await nightly(h);
  setFree(h, 50, 100 * GB);
  await nightly(h);
  assert.strictEqual(h.notices.length, 0);
  assert.deepStrictEqual(raw(h).notices, {});
});

// ── state ──
test('state: written atomically with mode 0600, holds the documented keys, no temp files left', async () => {
  const h = make();
  await nightly(h);
  const st = raw(h);
  for (const k of ['lastRun', 'lastFullRun', 'items', 'readings', 'starts', 'notices', 'lastNightlyDate']) assert.ok(k in st, k);
  assert.strictEqual(fs.statSync(h.stateFile).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(h.dir), ['system-health.json']);
});

test('state: an unparseable file is copied to .bad, logged, and the check starts fresh', async () => {
  const h = make();
  fs.writeFileSync(h.stateFile, '{ not json');
  const v = await manual(h);
  assert.strictEqual(fs.readFileSync(`${h.stateFile}.bad`, 'utf8'), '{ not json');
  assert.ok(h.logs.some(l => /\.bad/.test(l)));
  assert.ok(v.items.length > 0);
  assert.doesNotThrow(() => raw(h));
});

test('state: a file that is not an object is treated the same; a missing one is fine and makes no .bad', async () => {
  const h = make();
  fs.writeFileSync(h.stateFile, '[1,2]');
  await manual(h);
  assert.ok(fs.existsSync(`${h.stateFile}.bad`));
  const g = make();
  await manual(g);
  assert.ok(!fs.existsSync(`${g.stateFile}.bad`));
});

test('state: a new module over the same file keeps items, since and notices', async () => {
  const h = make();
  setFree(h, 2, 3 * GB); await manual(h);
  const again = createSystemHealth({ probes: h.probes, stateFile: h.stateFile, now: () => h.clock.now + HOUR, settings: () => ({}), paths: () => h.cfg.paths, notify: async (p) => h.notices.push({ p }) });
  assert.strictEqual(item(again.view(), DISK).level, 'critical');
  assert.strictEqual(item(again.view(), DISK).notified, true);
  await again.run({ trigger: 'manual' });
  assert.strictEqual(h.notices.length, 1, 'not told again');
});

// ── lists for the pages ──
test('readinessItems / briefItems / bannerItems', async () => {
  const h = make();
  setFree(h, 2, 3 * GB);
  h.cfg.clock = { synced: false, how: 'x' };
  h.cfg.signIns = [{ id: 'claude', name: 'Claude', agents: 2, signedIn: false }];
  await manual(h);
  const r = h.sh.readinessItems();
  assert.deepStrictEqual(r.map(i => i.id).sort(), [DISK, 'health-clock', 'health-claude-signedout'].sort(), 'no health-signin-* items; the Claude signed-out item passes');
  assert.deepStrictEqual(Object.keys(r[0]).sort(), ['action', 'detail', 'fix', 'id', 'level', 'title']);
  const b = h.sh.briefItems();
  assert.deepStrictEqual(b.map(i => i.id).sort(), [DISK, 'health-clock', 'health-signin-claude', 'health-claude-signedout'].sort());
  assert.deepStrictEqual(Object.keys(b[0]).sort(), ['detail', 'fix', 'id', 'level', 'since', 'title']);
  assert.ok(b.every(i => i.since));
  assert.deepStrictEqual(h.sh.bannerItems().map(i => i.id).sort(), [DISK, 'health-claude-signedout'].sort(), 'critical only, no health-signin-* (the Claude signed-out item carries the Sign in again action)');
  assert.strictEqual(h.sh.bannerItems().find(i => i.id === 'health-claude-signedout').action, 'claude-signin');
  assert.ok(![...r, ...b].some(i => i.level === 'ok' || i.level === 'info' || i.level === 'unknown'));
});

// ── scheduling ──
test('start(): the cheap run comes 60 s later, and is full only when the last full run is missing or 30+ minutes old', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const h = make();
  h.sh.start();
  t.mock.timers.tick(59999);
  await new Promise(r => setImmediate(r));
  assert.strictEqual(h.calls.disk, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.strictEqual(raw(h).lastRun.trigger, 'start');
  assert.strictEqual(raw(h).lastRun.full, true, 'no full run before: full');
  h.sh.stop();
  // a full run 10 minutes ago: the start run is cheap
  h.clock.now += 10 * MIN;
  h.sh.start();
  t.mock.timers.tick(60000);
  await settle();
  assert.strictEqual(raw(h).lastRun.trigger, 'start');
  assert.strictEqual(raw(h).lastRun.full, false);
  h.sh.stop();
  h.clock.now += 40 * MIN;
  h.sh.start();
  t.mock.timers.tick(60000);
  await settle();
  assert.strictEqual(raw(h).lastRun.full, true, '30+ minutes: full again');
  h.sh.stop();
});

test('start(): afterStart false or enabled false schedules no run; stop() clears the timers', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const a = make(); a.cfg.settings = { afterStart: false };
  a.sh.start(); t.mock.timers.tick(10 * MIN); await new Promise(r => setImmediate(r));
  assert.strictEqual(a.calls.disk, 0);
  a.sh.stop();
  const b = make(); b.cfg.settings = { enabled: false };
  b.sh.start(); t.mock.timers.tick(HOUR); await new Promise(r => setImmediate(r));
  assert.strictEqual(b.calls.disk, 0);
  assert.strictEqual(raw(b).starts.length, 1, 'the start is still recorded');
  const c = make();
  c.sh.start(); c.sh.stop(); t.mock.timers.tick(HOUR); await new Promise(r => setImmediate(r));
  assert.strictEqual(c.calls.disk, 0);
});

test('start(): the nightly run fires at checkAt (a full run), once, through the scheduler', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const h = make(); h.cfg.settings = { afterStart: false, checkAt: '03:15' };
  fs.writeFileSync(h.stateFile, JSON.stringify({ lastFullRun: { startedAt: new Date(T0 - 5 * HOUR).toISOString(), finishedAt: null, trigger: 'start', full: true } }));
  h.sh.start();
  t.mock.timers.tick(5 * MIN); await new Promise(r => setImmediate(r));
  assert.strictEqual(h.calls.disk, 0, '07:00: not the hour');
  h.clock.now = Date.parse('2026-11-18T08:16:00Z');   // 03:16 New York
  t.mock.timers.tick(5 * MIN);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.strictEqual(raw(h).lastRun.trigger, 'nightly');
  assert.strictEqual(raw(h).lastRun.full, true);
  assert.strictEqual(raw(h).lastNightlyDate, '2026-11-18');
  assert.strictEqual(h.calls.disk, 1);
  h.clock.now += 65 * MIN; t.mock.timers.tick(5 * MIN);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  assert.strictEqual(h.calls.disk, 1, 'once that night');
  h.sh.stop();
});

test('scheduler options: label and slotField (health / checkAt) fire at checkAt and log with the label', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const st = { lastRun: { startedAt: '2026-11-16T09:00:00Z' }, lastNightlyDate: null };
  const runs = [], lines = [];
  const s = { enabled: true, afterStart: true, checkAt: '03:15', nightlyAt: '09:00' };
  let now = Date.parse('2026-11-17T08:14:00Z');   // 03:14 New York
  const sched = createScheduler({
    now: () => now, zone: () => 'America/New_York', settings: () => s, getStored: () => st, setStored: (p) => Object.assign(st, p),
    isRunning: () => false, run: (a) => { runs.push(a.trigger); throw new Error('boom'); }, log: (m) => lines.push(m), label: 'health', slotField: 'checkAt',
  });
  assert.strictEqual(sched.isDue(), false, 'a minute before checkAt');
  now = Date.parse('2026-11-17T08:15:00Z');
  assert.strictEqual(sched.isDue(), true, 'at checkAt (nightlyAt 04:00 local is not looked at)');
  const tick = sched.schedule({ tickMs: 1000 });
  tick();
  assert.deepStrictEqual(runs, ['nightly']);
  assert.deepStrictEqual(lines, ['[health] nightly run failed: boom']);
  sched.stop();
});
