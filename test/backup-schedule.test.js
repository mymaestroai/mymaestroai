'use strict';
// Nightly backups (lib/backup/schedule.js): the time in the owner's zone (daylight saving included), once a day and a
// same-day catch-up, never right after setup or a change of time; waiting for working agents up to 30 minutes; a failure
// recorded and announced once; a warning when none was made for 3 days; the keep rules (newest nightly + the first of
// each recent week, counted rather than dated) applied only to nightly backups this computer made, still unchanged.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/backup/schedule');
const places = require('../lib/backup/places');
const restore = require('../lib/backup/restore');
const { createBackupService } = require('../lib/backup/service');
const { makeInstall, memSettings } = require('./helpers/backup-fixture');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-schedule-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const NY = 'America/New_York';
const Z = (s) => Date.parse(s);

test('the schedule: defaults, strict validation, the time in the zone (daylight saving), once a day', () => {
  assert.deepStrictEqual(S.normalize(undefined), { enabled: true, at: '03:30', keepNightly: 7, keepWeekly: 4 });
  assert.deepStrictEqual(S.normalize({ enabled: false, at: '25:00', keepNightly: 0, keepWeekly: 99 }), { enabled: false, at: '03:30', keepNightly: 7, keepWeekly: 4 });
  for (const bad of [null, [], {}, { enabled: 'yes', at: '03:30', keepNightly: 7, keepWeekly: 4 }, { enabled: true, at: '3:30', keepNightly: 7, keepWeekly: 4 },
    { enabled: true, at: '03:30', keepNightly: 0, keepWeekly: 4 }, { enabled: true, at: '03:30', keepNightly: 7.5, keepWeekly: 4 }, { enabled: true, at: '03:30', keepNightly: 7, keepWeekly: 53 },
    { enabled: true, at: '03:30', keepNightly: '7', keepWeekly: 4 }]) assert.throws(() => S.validate(bad), (e) => e.code === 'EBADSCHEDULE', JSON.stringify(bad));
  assert.deepStrictEqual(S.validate({ enabled: false, at: '23:05', keepNightly: 1, keepWeekly: 0, extra: 'x' }), { enabled: false, at: '23:05', keepNightly: 1, keepWeekly: 0 });
  // 03:30 in New York: EDT (UTC-4) until 1 Nov 2026, EST (UTC-5) after; 02:30 doesn't exist on 8 Mar 2026 (moved on to 03:30)
  assert.strictEqual(new Date(S.runTimeFor('2026-10-30', '03:30', NY)).toISOString(), '2026-10-30T07:30:00.000Z');
  assert.strictEqual(new Date(S.runTimeFor('2026-11-01', '03:30', NY)).toISOString(), '2026-11-01T08:30:00.000Z');
  assert.strictEqual(new Date(S.runTimeFor('2026-03-08', '02:30', NY)).toISOString(), '2026-03-08T07:30:00.000Z');
  assert.strictEqual(new Date(S.runTimeFor('2026-10-30', '03:30', 'Asia/Kolkata')).toISOString(), '2026-10-29T22:00:00.000Z');
  const sc = S.normalize();
  assert.strictEqual(S.dueDate(sc, Z('2026-10-30T07:29:00Z'), NY, '2026-10-29'), null, 'not before the time');
  assert.strictEqual(S.dueDate(sc, Z('2026-10-30T07:30:00Z'), NY, '2026-10-29'), '2026-10-30');
  assert.strictEqual(S.dueDate(sc, Z('2026-10-30T15:00:00Z'), NY, '2026-10-29'), '2026-10-30', 'a computer that slept catches up the same day');
  assert.strictEqual(S.dueDate(sc, Z('2026-10-30T15:00:00Z'), NY, '2026-10-30'), null, 'once a day');
  assert.strictEqual(S.dueDate(sc, Z('2026-10-30T15:00:00Z'), NY, '2026-10-31'), null, 'a zone that moved back a day waits');
  assert.strictEqual(S.dueDate(sc, Z('2026-10-31T03:00:00Z'), NY, '2026-10-29'), '2026-10-30', 'the catch-up lasts until midnight there');
  assert.strictEqual(S.dueDate(sc, Z('2026-10-31T04:30:00Z'), NY, '2026-10-29'), null, 'after midnight the missed night is gone: the 31st waits for its time');
  assert.strictEqual(new Date(S.nextRun(sc, Z('2026-10-30T05:00:00Z'), NY, '2026-10-29')).toISOString(), '2026-10-30T07:30:00.000Z');
  assert.strictEqual(new Date(S.nextRun(sc, Z('2026-10-30T09:00:00Z'), NY, '2026-10-30')).toISOString(), '2026-10-31T07:30:00.000Z');
  assert.strictEqual(new Date(S.nextRun(sc, Z('2026-10-31T09:00:00Z'), NY, '2026-10-31')).toISOString(), '2026-11-01T08:30:00.000Z', 'the night the clocks go back');
});

test('the keep rules: the newest nightly backups, the first backup of each recent week (in the zone), counted not dated', () => {
  // Sunday 25 Oct 2026 23:30 in New York is Monday 03:30 in UTC: a different week
  assert.strictEqual(S.weekOf(Z('2026-10-26T03:30:00Z'), NY), '2026-10-19');
  assert.strictEqual(S.weekOf(Z('2026-10-26T03:30:00Z'), 'UTC'), '2026-10-26');
  const day = (d) => ({ name: `n-${d}`, created: new Date(Z(`${d}T07:30:00Z`)).toISOString() });
  const recs = [];
  for (let t = Z('2026-09-20T00:00:00Z'); t <= Z('2026-10-29T00:00:00Z'); t += 86400000) recs.push(day(new Date(t).toISOString().slice(0, 10)));
  assert.strictEqual(recs.length, 40);
  const keep = S.toKeep(recs, { keepNightly: 7, keepWeekly: 4, tz: NY });
  assert.deepStrictEqual([...keep].sort(), ['n-2026-10-05', 'n-2026-10-12', 'n-2026-10-19', 'n-2026-10-23', 'n-2026-10-24', 'n-2026-10-25', 'n-2026-10-26', 'n-2026-10-27', 'n-2026-10-28', 'n-2026-10-29']);
  // a computer off for a month: the history it had is still there (nothing goes by time alone)
  const old = recs.slice(0, 5);
  assert.strictEqual(S.toKeep(old, { keepNightly: 7, keepWeekly: 4, tz: NY }).size, 5);
  // at least the newest is always kept; what can't be dated is never deleted
  assert.deepStrictEqual([...S.toKeep([...recs.slice(0, 3), { name: 'odd', created: 'not a date' }], { keepNightly: 0, keepWeekly: 0, tz: NY })].sort(), ['n-2026-09-22', 'odd']);
});

// A stand-in for backup/service.js: the facts the scheduler reads, and its calls
function fakeService(clock, extra = {}) {
  const calls = [];
  const svc = {
    calls, busy: [], fail: null,
    st: { key: { configured: true, keyId: 'k1', createdAt: '2026-10-01T00:00:00.000Z' }, needsPassword: false, recovery: null, running: null, last: null, schedule: undefined, ...extra },
    status() { return { ...svc.st, schedule: S.normalize(svc.st.schedule) }; },
    async backupNow({ now, reason }) {
      calls.push({ backup: true, now, reason, at: new Date(clock.t).toISOString() });
      if (svc.fail) throw svc.fail;
      if (!now && svc.busy.length) return { waiting: true, working: svc.busy.slice() };
      if (svc.gate) await svc.gate;
      const where = [{ kind: 'local', dir: '/x', file: `/x/b-${calls.length}` }, ...(svc.copyFail ? [{ kind: 'folder', dir: '/nas', error: 'not reachable' }] : [])];
      svc.st.last = { created: new Date(clock.t).toISOString(), name: `b-${calls.length}`, places: where };
      return { done: true, backup: { name: `b-${calls.length}`, places: where } };
    },
    async applyRetention(o) { calls.push({ retention: o }); return { deleted: [] }; },
  };
  return svc;
}
function schedulerFor(name, clock, svc, opts = {}) {
  const root = path.join(TMP, name); fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const notes = [];
  const sch = S.createScheduler({ service: svc, root, zone: () => NY, now: () => clock.t, notify: async (p) => { notes.push(p); }, ...opts });
  return { sch, notes, root };
}

test('the nightly run: not right after setup, at the time each night, waits for agents up to 30 minutes, then the keep rules', async () => {
  const clock = { t: Z('2026-10-29T16:00:00Z') };   // 12:00 in New York
  const svc = fakeService(clock, { key: { configured: true, keyId: 'k1', createdAt: '2026-10-29T15:00:00.000Z' } });
  const { sch, notes, root } = schedulerFor('run', clock, svc);
  await sch.tick();
  assert.deepStrictEqual(svc.calls, [], 'setting up at noon doesn\'t start a backup');
  assert.strictEqual(sch.state().notBefore, '2026-10-29T16:00:00.000Z');
  assert.strictEqual(sch.state().lastDate, undefined);
  assert.strictEqual(sch.info().nextRun, '2026-10-30T07:30:00.000Z');
  assert.strictEqual(sch.info().tz, NY);
  clock.t = Z('2026-10-30T07:29:00Z'); await sch.tick();
  assert.strictEqual(svc.calls.length, 0);
  clock.t = Z('2026-10-30T07:30:00Z'); await sch.tick();
  assert.deepStrictEqual(svc.calls.map(c => c.backup ? `${c.reason}:${c.now}` : `keep:${c.retention.keepNightly}/${c.retention.keepWeekly}/${c.retention.tz}`), ['nightly:false', `keep:7/4/${NY}`]);
  assert.strictEqual(sch.state().lastDate, '2026-10-30');
  assert.strictEqual(sch.state().lastOkAt, '2026-10-30T07:30:00.000Z');
  clock.t = Z('2026-10-30T07:31:00Z'); await sch.tick();
  assert.strictEqual(svc.calls.length, 2, 'once a night');
  // agents working: try each minute without forcing; after 30 minutes, go ahead anyway
  svc.calls.length = 0; svc.busy = ['degen'];
  clock.t = Z('2026-10-31T07:30:00Z'); await sch.tick();
  assert.strictEqual(sch.info().waitingSince, '2026-10-31T07:30:00.000Z');
  clock.t = Z('2026-10-31T07:45:00Z'); await sch.tick();
  clock.t = Z('2026-10-31T08:00:00Z'); await sch.tick();
  assert.deepStrictEqual(svc.calls.filter(c => c.backup).map(c => c.now), [false, false, true]);
  assert.strictEqual(sch.state().lastDate, '2026-10-31');
  assert.strictEqual(sch.info().waitingSince, null);
  assert.strictEqual(notes.length, 0);
  // the night the clocks go back: 03:30 EST
  svc.calls.length = 0; svc.busy = [];
  clock.t = Z('2026-11-01T07:30:00Z'); await sch.tick();   // 02:30 EST
  assert.strictEqual(svc.calls.length, 0);
  clock.t = Z('2026-11-01T08:30:00Z'); await sch.tick();
  assert.strictEqual(svc.calls.filter(c => c.backup).length, 1);
  assert.strictEqual(sch.state().lastDate, '2026-11-01');
  // a wait that crosses midnight still makes that night's backup (a late time), filed under the night it was for
  svc.calls.length = 0; svc.busy = ['degen'];
  svc.st.schedule = { enabled: true, at: '23:50', keepNightly: 7, keepWeekly: 4 };
  clock.t = Z('2026-11-03T04:50:00Z'); await sch.tick();   // 23:50 on 2 Nov (EST)
  svc.busy = [];
  clock.t = Z('2026-11-03T05:05:00Z'); await sch.tick();   // 00:05 on 3 Nov
  assert.deepStrictEqual(svc.calls.filter(c => c.backup).map(c => c.now), [false, false]);
  assert.strictEqual(sch.state().lastDate, '2026-11-02');
  clock.t = Z('2026-11-03T05:06:00Z'); await sch.tick();
  assert.strictEqual(svc.calls.filter(c => c.backup).length, 2, 'and not again for the 3rd before its own time');
  assert.strictEqual(notes.length, 0);
  assert.strictEqual(fs.statSync(path.join(root, 'data', 'backup-schedule.json')).mode & 0o777, 0o600);
});

test('a failed night: recorded, announced once, no retry that day; the next night clears it; copies that failed are named', async () => {
  const clock = { t: Z('2026-10-29T16:00:00Z') };
  const svc = fakeService(clock, { last: { created: '2026-10-29T07:30:00.000Z' } });
  const { sch, notes } = schedulerFor('fail', clock, svc);
  await sch.tick();
  svc.fail = Object.assign(new Error('Not enough free space in /backups for this backup.'), { code: 'ENOSPC' });
  clock.t = Z('2026-10-30T07:30:00Z'); await sch.tick();
  clock.t = Z('2026-10-30T07:31:00Z'); await sch.tick();
  clock.t = Z('2026-10-30T12:00:00Z'); await sch.tick();
  assert.strictEqual(svc.calls.filter(c => c.backup).length, 1, 'no retry that day (Back up now is there)');
  assert.strictEqual(svc.calls.filter(c => c.retention).length, 0, 'nothing deleted after a failure');
  assert.deepStrictEqual(notes.map(n => n.title), ['The nightly backup failed']);
  assert.strictEqual(notes[0].body, 'Open Settings → Backups for the details.', 'the details stay on the admin page, not on a lock screen');
  assert.strictEqual(notes[0].url, '/?backups=1');
  assert.strictEqual(sch.info().lastError.date, '2026-10-30');
  assert.ok(sch.readinessItems().some(i => i.id === 'backups-failed' && i.level === 'warn'));
  // busy elsewhere (a password change running): not a failure, tried again a minute later
  svc.fail = Object.assign(new Error('A backup is already running.'), { code: 'EBUSY' });
  clock.t = Z('2026-10-31T07:30:00Z'); await sch.tick();
  assert.strictEqual(sch.state().lastDate, '2026-10-30');
  svc.fail = null; svc.copyFail = true;
  clock.t = Z('2026-10-31T07:31:00Z'); await sch.tick();
  assert.strictEqual(sch.state().lastError, null);
  assert.deepStrictEqual(sch.info().copyErrors, [{ dir: '/nas', error: 'not reachable' }]);
  const items = sch.readinessItems();
  assert.ok(!items.some(i => i.id === 'backups-failed'));
  assert.ok(items.some(i => i.id === 'backups-copies' && /\/nas/.test(i.detail)));
  assert.strictEqual(notes.length, 1);
});

test('a full disk: the state can\'t be saved, yet each night is tried once and a failure announced once', async () => {
  const clock = { t: Z('2026-10-29T16:00:00Z') };
  const svc = fakeService(clock, { last: { created: '2026-10-29T07:30:00.000Z' } });
  const { sch, notes, root } = schedulerFor('full', clock, svc);
  fs.chmodSync(path.join(root, 'data'), 0o500);
  try {
    await sch.tick();
    assert.strictEqual(sch.state().notBefore, '2026-10-29T16:00:00.000Z', 'kept in memory');
    svc.fail = Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
    for (const t of ['2026-10-30T07:30:00Z', '2026-10-30T07:31:00Z', '2026-10-30T09:00:00Z']) { clock.t = Z(t); await sch.tick(); }
    assert.strictEqual(svc.calls.filter(c => c.backup).length, 1);
    assert.deepStrictEqual(notes.map(n => n.tag), ['backup-failed']);
    assert.ok(sch.readinessItems().some(i => i.id === 'backups-failed'));
    assert.ok(!fs.existsSync(path.join(root, 'data', 'backup-schedule.json')));
  } finally { fs.chmodSync(path.join(root, 'data'), 0o700); }
  svc.fail = null;
  clock.t = Z('2026-10-31T07:30:00Z'); await sch.tick();
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'data', 'backup-schedule.json'), 'utf8')).lastDate, '2026-10-31', 'written once it can be');
});

test('stopped: off, not set up, waiting for a new password, or paused after a restore; a change of time never starts one at once', async () => {
  const clock = { t: Z('2026-10-29T16:00:00Z') };
  const svc = fakeService(clock, { schedule: { enabled: false, at: '03:30', keepNightly: 7, keepWeekly: 4 }, last: { created: '2026-10-01T00:00:00.000Z' } });
  const { sch, notes } = schedulerFor('stopped', clock, svc);
  for (const [why, set] of [['off', () => {}], ['needs a password', () => { svc.st.schedule = undefined; svc.st.needsPassword = true; }],
    ['paused', () => { svc.st.needsPassword = false; svc.st.recovery = { since: 'x', resumedAt: null }; }]]) {
    set();
    clock.t += 86400000; await sch.tick();
    assert.strictEqual(svc.calls.length, 0, why);
  }
  assert.strictEqual(sch.info().nextRun, null);
  assert.strictEqual(sch.info().paused, true);
  assert.deepStrictEqual(notes.map(n => [n.tag, n.title]), [['backup-paused', 'Backups are paused']], 'only "choose a new password" (once); nothing while off or paused after a restore');
  // not set up: nothing at all, and the checklist says so
  const svc2 = fakeService(clock, { key: { configured: false } });
  const s2 = schedulerFor('nokey', clock, svc2);
  await s2.sch.tick();
  assert.strictEqual(svc2.calls.length, 0);
  assert.deepStrictEqual(s2.sch.readinessItems().map(i => [i.id, i.level, i.title]), [['backups', 'warn', 'Backups aren\'t set up']]);
  svc.st.recovery = { since: 'x', resumedAt: 'y' };
  assert.deepStrictEqual(sch.readinessItems().map(i => i.id), ['backups-stale']);
  // a new time already past today waits for tomorrow; a later time today still runs today
  const svc3 = fakeService(clock); const s3 = schedulerFor('resched', clock, svc3);
  clock.t = Z('2026-11-05T17:00:00Z');   // 12:00 EST
  fs.writeFileSync(path.join(s3.root, 'data', 'backup-schedule.json'), JSON.stringify({ lastDate: '2026-11-04' }));
  svc3.st.schedule = { enabled: true, at: '09:00', keepNightly: 7, keepWeekly: 4 };
  s3.sch.rescheduled();
  await s3.sch.tick();
  assert.strictEqual(svc3.calls.length, 0, '09:00 is past: tomorrow');
  assert.strictEqual(s3.sch.info().nextRun, '2026-11-06T14:00:00.000Z');
  fs.writeFileSync(path.join(s3.root, 'data', 'backup-schedule.json'), JSON.stringify({ lastDate: '2026-11-04' }));
  svc3.st.schedule = { enabled: true, at: '15:00', keepNightly: 7, keepWeekly: 4 };
  s3.sch.rescheduled();
  await s3.sch.tick();
  assert.strictEqual(svc3.calls.length, 0);
  clock.t = Z('2026-11-05T20:00:00Z'); await s3.sch.tick();
  assert.strictEqual(svc3.calls.filter(c => c.backup).length, 1, '15:00 today runs today');
  // the usual case: set up at noon (03:30 has passed), then the time changed to 22:15: tonight's backup happens
  const svc4 = fakeService(clock); const s4 = schedulerFor('resched2', clock, svc4);
  clock.t = Z('2026-11-06T17:00:00Z'); await s4.sch.tick();
  assert.strictEqual(svc4.calls.length, 0);
  svc4.st.schedule = { enabled: true, at: '22:15', keepNightly: 7, keepWeekly: 4 };
  clock.t = Z('2026-11-06T18:00:00Z'); s4.sch.rescheduled();
  assert.strictEqual(s4.sch.info().nextRun, '2026-11-07T03:15:00.000Z');
  clock.t = Z('2026-11-07T03:15:00Z'); await s4.sch.tick();
  assert.strictEqual(svc4.calls.filter(c => c.backup).length, 1);
  assert.strictEqual(s4.sch.state().lastDate, '2026-11-06');
});

test('no backup for 3 days: one warning per stretch, again after the next stretch; the checklist says how long', async () => {
  const clock = { t: Z('2026-10-29T16:00:00Z') };
  const svc = fakeService(clock, { last: { created: '2026-10-20T07:30:00.000Z' } });
  const { sch, notes } = schedulerFor('stale', clock, svc);
  await sch.tick(); await sch.tick();
  assert.deepStrictEqual(notes.map(n => n.title), ['No backup for 9 days']);
  assert.match(notes[0].body, /2026-10-20 03:30 EDT/);
  assert.ok(sch.readinessItems().some(i => i.id === 'backups-stale' && i.title === 'No backup for 9 days'));
  clock.t = Z('2026-10-30T07:30:00Z'); await sch.tick();   // a backup is made: the stretch ends
  assert.ok(!sch.readinessItems().some(i => i.id === 'backups-stale'));
  assert.deepStrictEqual(sch.readinessItems().map(i => i.level), ['ok']);
  assert.match(sch.readinessItems()[0].detail, /^Last backup 2026-10-30 03:30 EDT; next 2026-10-31 03:30 EDT\.$/);
  svc.fail = new Error('the disk went away');
  for (let d = 1; d <= 4; d++) { clock.t = Z('2026-10-30T07:30:00Z') + d * 86400000 + 3600000; await sch.tick(); }
  assert.deepStrictEqual(notes.map(n => n.tag), ['backup-stale', 'backup-failed', 'backup-failed', 'backup-failed', 'backup-stale', 'backup-failed'], 'each failed night once; a new stretch of 3 days warns again');
  // never made one at all: counted from the key's day
  const svc2 = fakeService(clock, { key: { configured: true, keyId: 'k', createdAt: '2026-10-25T00:00:00.000Z' } });
  const s2 = schedulerFor('never', clock, svc2);
  svc2.fail = new Error('no room');
  await s2.sch.tick();
  assert.ok(s2.notes.some(n => n.title === 'No backup has been made yet'));
});

test('a restart: a night that was due (agents working) is still made, filed under its night; the 30-minute wait goes on', async () => {
  const clock = { t: Z('2026-11-03T04:50:00Z') };   // 23:50 on 2 Nov (EST)
  const svc = fakeService(clock, { schedule: { enabled: true, at: '23:50', keepNightly: 7, keepWeekly: 4 }, last: { created: '2026-11-02T04:50:00.000Z' } });
  const root = path.join(TMP, 'restart'); fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'backup-schedule.json'), JSON.stringify({ lastDate: '2026-11-01' }));
  svc.busy = ['degen'];
  const one = S.createScheduler({ service: svc, root, zone: () => NY, now: () => clock.t });
  await one.tick();
  assert.deepStrictEqual([one.state().pendingDate, one.state().waitingSince], ['2026-11-02', '2026-11-03T04:50:00.000Z']);
  // the hub restarts after midnight; agents still working at 00:21: the wait began at 23:50, so it goes ahead
  const two = S.createScheduler({ service: svc, root, zone: () => NY, now: () => clock.t });
  clock.t = Z('2026-11-03T05:10:00Z'); await two.tick();
  clock.t = Z('2026-11-03T05:21:00Z'); await two.tick();
  assert.deepStrictEqual(svc.calls.filter(c => c.backup).map(c => c.now), [false, false, true]);
  assert.strictEqual(two.state().lastDate, '2026-11-02');
  assert.strictEqual(two.state().pendingDate, null);
  // a claim older than yesterday is dropped (a hub that was off for days doesn't file an old night)
  fs.writeFileSync(path.join(root, 'data', 'backup-schedule.json'), JSON.stringify({ lastDate: '2026-11-01', pendingDate: '2026-11-01', notBefore: '2026-11-01T00:00:00.000Z' }));
  const three = S.createScheduler({ service: svc, root, zone: () => NY, now: () => clock.t });
  clock.t = Z('2026-11-05T12:00:00Z'); svc.calls.length = 0; await three.tick();
  assert.strictEqual(svc.calls.length, 0);
  assert.strictEqual(three.state().pendingDate, null);
});

test('a schedule saved while the backup runs: that night\'s keep rules wait (the next night uses the new counts)', async () => {
  const clock = { t: Z('2026-10-29T16:00:00Z') };
  const svc = fakeService(clock, { last: { created: '2026-10-29T07:30:00.000Z' } });
  const { sch } = schedulerFor('race', clock, svc);
  await sch.tick();
  let open; svc.gate = new Promise(r => { open = r; });
  clock.t = Z('2026-10-30T07:30:00Z');
  const running = sch.tick();
  await new Promise(r => setImmediate(r));
  svc.st.schedule = { enabled: true, at: '03:30', keepNightly: 2, keepWeekly: 0 };
  sch.rescheduled();
  open(); await running;
  assert.strictEqual(svc.calls.filter(c => c.retention).length, 0, 'no deletion with the counts from before the change');
  assert.strictEqual(sch.state().lastDate, '2026-10-30', 'the backup itself is recorded');
  svc.gate = null;
  clock.t = Z('2026-10-31T07:30:00Z'); await sch.tick();
  assert.deepStrictEqual(svc.calls.filter(c => c.retention).map(c => [c.retention.keepNightly, c.retention.keepWeekly, c.retention.justMade]), [[2, 0, 'b-2']]);
});

test('a warning that wasn\'t delivered is tried again 15 minutes later, then not again', async () => {
  const clock = { t: Z('2026-10-29T16:00:00Z') };
  const svc = fakeService(clock, { last: { created: '2026-10-20T07:30:00.000Z' } });
  const tries = [];
  let answer = { sent: 0, failed: 2 };
  const root = path.join(TMP, 'retry'); fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const sch = S.createScheduler({ service: svc, root, zone: () => NY, now: () => clock.t, notify: async (p) => { tries.push([clock.t, p.tag]); return answer; } });
  await sch.tick();
  clock.t += 5 * 60000; await sch.tick();
  assert.strictEqual(tries.length, 1, 'not every minute');
  answer = { sent: 1, failed: 1 };
  clock.t += 11 * 60000; await sch.tick();
  clock.t += 60 * 60000; await sch.tick();
  assert.deepStrictEqual(tries.map(t => t[1]), ['backup-stale', 'backup-stale'], 'delivered on the second try, then quiet');
  const thrower = S.createScheduler({ service: fakeService(clock, { last: { created: '2026-10-20T07:30:00.000Z' } }), root: path.join(TMP, 'retry2'), zone: () => NY, now: () => clock.t, notify: async () => { throw new Error('push service down'); } });
  fs.mkdirSync(path.join(TMP, 'retry2', 'data'), { recursive: true });
  await thrower.tick();
  assert.ok(!(thrower.state().alerted || {}).stale, 'a notification that threw is not marked as delivered');
});

test('paused (a new password, a restore): a night that was due stays claimed and is made after; a nameless result is a failure; a skipped tidy is shown', async () => {
  const clock = { t: Z('2026-11-03T04:50:00Z') };   // 23:50 on 2 Nov (EST)
  const svc = fakeService(clock, { schedule: { enabled: true, at: '23:50', keepNightly: 7, keepWeekly: 4 }, last: { created: '2026-11-02T04:50:00.000Z' } });
  const root = path.join(TMP, 'paused-claim'); fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'backup-schedule.json'), JSON.stringify({ lastDate: '2026-11-01' }));
  const notes = [];
  const sch = S.createScheduler({ service: svc, root, zone: () => NY, now: () => clock.t, notify: async (p) => { notes.push(p.tag); } });
  svc.busy = ['degen'];
  await sch.tick();
  svc.st.recovery = { since: 'x', resumedAt: null };
  clock.t = Z('2026-11-03T05:05:00Z'); await sch.tick();
  assert.strictEqual(sch.state().pendingDate, '2026-11-02', 'kept while paused');
  svc.st.recovery = { since: 'x', resumedAt: 'y' }; svc.busy = [];
  clock.t = Z('2026-11-03T05:30:00Z'); await sch.tick();
  assert.deepStrictEqual(svc.calls.filter(c => c.backup).map(c => c.now), [false, true], 'made after Resume (the 30 minutes were up)');
  assert.strictEqual(sch.state().lastDate, '2026-11-02');
  // a result without a file name: a failed night, nothing deleted
  const nameless = svc.backupNow; svc.backupNow = async (o) => { svc.calls.push({ backup: true, now: o.now }); return { done: true, backup: {} }; };
  svc.st.schedule = undefined;
  clock.t = Z('2026-11-03T08:30:00Z'); await sch.tick();
  assert.match(sch.state().lastError.message, /without a file name/);
  assert.strictEqual(svc.calls.filter(c => c.retention).length, 1, 'only the earlier night\'s tidy');
  svc.backupNow = nameless;
  // the tidy skipped (a wrong clock): kept on record for the page and the checklist, cleared by a normal night
  svc.applyRetention = async (o) => { svc.calls.push({ retention: o }); return { deleted: [], why: 'tonight\'s backup is not the newest (is the computer\'s clock right?)' }; };
  clock.t = Z('2026-11-04T08:30:00Z'); await sch.tick();
  assert.match(sch.info().keepSkipped.why, /not the newest/);
  assert.ok(sch.readinessItems().some(i => i.id === 'backups-keep' && i.level === 'warn' && /date and time/.test(i.fix)));
  // a pass skipped only because something else was busy says nothing new: the warning stays
  svc.applyRetention = async (o) => { svc.calls.push({ retention: o, quiet: true }); return { deleted: [], skipped: true }; };
  clock.t = Z('2026-11-05T08:30:00Z'); await sch.tick();
  assert.strictEqual(svc.calls.filter(c => c.quiet).length, 1, 'the quiet skip happened');
  assert.ok(sch.info().keepSkipped, 'still shown');
  svc.applyRetention = async (o) => { svc.calls.push({ retention: o }); return { deleted: [] }; };
  clock.t = Z('2026-11-06T08:30:00Z'); await sch.tick();
  assert.strictEqual(sch.info().keepSkipped, null, 'a pass that ran clears it');
  // waiting for a new password: told once per stretch
  svc.st.needsPassword = true;
  await sch.tick(); await sch.tick();
  svc.st.needsPassword = false; await sch.tick();
  svc.st.needsPassword = true; await sch.tick();
  assert.deepStrictEqual(notes.filter(n => n === 'backup-paused').length, 2);
});

test('the keep rules on a real install: only nightly backups this computer made, where it wrote them, unchanged; tonight\'s is kept; never during a restore', async () => {
  const inst = makeInstall(TMP, 'keep');
  const disk = path.join(TMP, 'keep-disk'); fs.mkdirSync(disk);
  const usb = path.join(TMP, 'keep-usb');   // a backup folder that is unplugged right now
  const settings = memSettings();
  const svc = createBackupService({ ...inst, platform: 'linux', settings, hubInfo: () => ({}) });
  settings.update({ backup: { ...(settings.get().backup || {}), folders: [{ dir: disk }, { dir: usb }] } });
  const local = path.join(inst.hubHome, 'backups'); fs.mkdirSync(local, { recursive: true });
  const put = (dir, name, size) => fs.writeFileSync(path.join(dir, name), Buffer.alloc(size, 1));
  const at = (dir, name) => ({ kind: dir === local ? 'local' : 'folder', dir, file: path.join(dir, name) });
  const names = [];
  for (let t = Z('2026-09-20T07:30:00Z'); t <= Z('2026-10-29T07:30:00Z'); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10), name = `my-maestro-ai-${d}-0330.age`, i = names.length;
    names.push(name);
    // names[1] was written only here (the disk was added later); names[2] and names[3] also went to the USB disk
    const where = i === 1 ? [at(local, name)] : i === 2 || i === 3 ? [at(local, name), at(disk, name), at(usb, name)] : [at(local, name), at(disk, name)];
    places.recordInIndex(inst.root, { id: name.replace(/\.age$/, ''), name, created: new Date(t).toISOString(), size: 64, reason: 'nightly', places: where });
    put(local, name, 64); put(disk, name, 64);
  }
  places.recordInIndex(inst.root, { id: 'my-maestro-ai-2026-09-01-1200', name: 'my-maestro-ai-2026-09-01-1200.age', created: '2026-09-01T16:00:00.000Z', size: 64, reason: 'manual', places: [at(local, 'my-maestro-ai-2026-09-01-1200.age')] });
  put(local, 'my-maestro-ai-2026-09-01-1200.age', 64);
  put(local, 'my-maestro-ai-2026-09-02-0330.age', 64);                 // a file this computer didn't make (not in its record)
  put(disk, names[0], 65);                                             // changed since: left alone on that disk
  const tonight = names[names.length - 1];
  // a checked restore waiting: nothing is touched
  const d = restore.restoreDirs(inst.root);
  fs.mkdirSync(path.dirname(d.prepared), { recursive: true }); fs.writeFileSync(d.prepared, '{}');
  assert.strictEqual((await svc.applyRetention({ keepNightly: 7, keepWeekly: 4, tz: NY, justMade: tonight })).skipped, true);
  fs.rmSync(d.prepared);
  // tonight's backup missing, or not the newest (a wrong clock): nothing is deleted
  assert.match((await svc.applyRetention({ keepNightly: 7, keepWeekly: 4, tz: NY, justMade: 'my-maestro-ai-2026-12-01-0330.age' })).why, /not where it was written/);
  assert.match((await svc.applyRetention({ keepNightly: 7, keepWeekly: 4, tz: NY, justMade: names[5] })).why, /not the newest/);
  assert.strictEqual(fs.readdirSync(local).length, 42);
  const r = await svc.applyRetention({ keepNightly: 7, keepWeekly: 4, tz: NY, justMade: tonight });
  assert.strictEqual(r.skipped, false);
  assert.deepStrictEqual(r.failed, []);
  assert.strictEqual(r.deleted.length, 30 + 28, '30 here; 28 on the disk (the changed copy and the one put there by someone else stay)');
  const kept = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'].map(x => `my-maestro-ai-${x}-0330.age`);
  assert.deepStrictEqual(fs.readdirSync(local).sort(), [...kept, 'my-maestro-ai-2026-09-01-1200.age', 'my-maestro-ai-2026-09-02-0330.age'].sort());
  assert.deepStrictEqual(fs.readdirSync(disk).sort(), [names[0], names[1], ...kept].sort());
  // the record forgets a backup only when every copy it knows of was deleted: the changed copy, and the USB disk that
  // is away, keep theirs; names[1] (written only here) is forgotten, so its stray copy on the disk is never touched
  const idx = places.index(inst.root).map(b => b.name).sort();
  assert.deepStrictEqual(idx, [...kept, names[0], names[2], names[3], 'my-maestro-ai-2026-09-01-1200.age'].sort());
  assert.strictEqual(svc.running, null);
  // the default and the stored schedule
  assert.deepStrictEqual(svc.status().schedule, S.DEFAULTS);
  assert.throws(() => svc.setSchedule({ enabled: true, at: '3am', keepNightly: 7, keepWeekly: 4 }), /like 03:30/);
  assert.deepStrictEqual(svc.setSchedule({ enabled: false, at: '01:15', keepNightly: 3, keepWeekly: 2 }), { enabled: false, at: '01:15', keepNightly: 3, keepWeekly: 2 });
  assert.deepStrictEqual(svc.status().schedule, { enabled: false, at: '01:15', keepNightly: 3, keepWeekly: 2 });
  assert.ok(settings.get().backup.folders.length === 2, 'the other backup settings stay');
  // the USB disk unplugged but its mount folder still there, empty but for a stray copy never written there: taken
  // as away, so its records stay
  fs.mkdirSync(usb); put(usb, kept[0], 64);
  await svc.applyRetention({ keepNightly: 7, keepWeekly: 4, tz: NY, justMade: tonight });
  assert.ok(places.index(inst.root).some(b => b.name === names[2]) && places.index(inst.root).some(b => b.name === names[3]));
  // a record that names no place at all is kept (nothing says where its copies are)
  places.recordInIndex(inst.root, { id: 'my-maestro-ai-2026-09-10-0330', name: 'my-maestro-ai-2026-09-10-0330.age', created: '2026-09-10T07:30:00.000Z', size: 64, reason: 'nightly', places: [] });
  await svc.applyRetention({ keepNightly: 7, keepWeekly: 4, tz: NY, justMade: tonight });
  assert.ok(places.index(inst.root).some(b => b.name === 'my-maestro-ai-2026-09-10-0330.age'));
  // a later night, with the USB disk back and fewer to keep: each place keeps its own newest (the USB disk its
  // names[3]); names[2]'s last copy goes there, and with no copy left anywhere (deleted on two nights), its record too
  fs.rmSync(path.join(usb, kept[0])); put(usb, names[2], 64); put(usb, names[3], 64);
  const r2 = await svc.applyRetention({ keepNightly: 1, keepWeekly: 0, tz: NY, justMade: tonight });
  assert.ok(r2.deleted.includes(path.join(usb, names[2])) && !r2.deleted.includes(path.join(usb, names[3])), r2.deleted.join(' '));
  assert.deepStrictEqual(fs.readdirSync(local).sort(), [tonight, 'my-maestro-ai-2026-09-01-1200.age', 'my-maestro-ai-2026-09-02-0330.age'].sort());
  assert.deepStrictEqual(fs.readdirSync(usb), [names[3]]);
  assert.deepStrictEqual(places.index(inst.root).map(b => b.name).sort(), [names[0], names[3], tonight, 'my-maestro-ai-2026-09-01-1200.age', 'my-maestro-ai-2026-09-10-0330.age'].sort());
  // a record dated far ahead (an old clock glitch) keeps its slot but doesn't stop the tidying every night
  const future = 'my-maestro-ai-2027-01-01-0330.age';
  places.recordInIndex(inst.root, { id: future.replace(/\.age$/, ''), name: future, created: '2027-01-01T08:30:00.000Z', size: 64, reason: 'nightly', places: [at(local, future)] });
  put(local, future, 64);
  const r3 = await svc.applyRetention({ keepNightly: 7, keepWeekly: 4, tz: NY, justMade: tonight });
  assert.strictEqual(r3.skipped, false, r3.why);
  assert.ok(fs.existsSync(path.join(local, future)));
  // tonight's backup has to be named; no new counts while the tidying runs
  assert.match((await svc.applyRetention({ keepNightly: 7, keepWeekly: 4, tz: NY })).why, /no backup was named/);
  const stale = 'my-maestro-ai-2026-09-15-0330.age';   // something to delete, so the pass takes a moment
  places.recordInIndex(inst.root, { id: stale.replace(/\.age$/, ''), name: stale, created: '2026-09-15T07:30:00.000Z', size: 64, reason: 'nightly', places: [at(local, stale)] });
  put(local, stale, 64);
  const busy = svc.applyRetention({ keepNightly: 2, keepWeekly: 0, tz: NY, justMade: tonight });
  assert.throws(() => svc.setSchedule({ enabled: true, at: '03:30', keepNightly: 1, keepWeekly: 0 }), (e) => e.code === 'EBUSY');
  assert.deepStrictEqual((await busy).deleted, [path.join(local, stale)]);
  assert.deepStrictEqual(svc.setSchedule({ enabled: true, at: '03:30', keepNightly: 9, keepWeekly: 1 }).keepNightly, 9);
});

test('wiring: the route asks again for the password, the server starts the ticker, the checklist and the page read it', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const server = read('server.js');
  const route = server.slice(server.indexOf("pathname === '/api/backups/schedule'"));
  assert.match(route.slice(0, 400), /const no = stepUp\(b\); if \(no\) return jsonResponse\(res, 403/);
  assert.match(server, /require\('\.\/lib\/backup\/schedule'\)\.createScheduler\(\{[^]*?\}\)\.start\(\)/);
  assert.match(read('lib/readiness.js'), /backupItems: \(\) => \{ const s = require\('\.\/backup\/schedule'\)\.current\(\)/);
  const app = read('app.js');
  assert.match(app, /function bkScheduleDialog\(\)/);
  assert.match(app, /get\('backups'\) === '1'\) openSettingsAt\('st-backups-section'\)/);
  assert.match(read('lib/backup/collect.js'), /\/\^backup-schedule\\\.json\$\//);
});
