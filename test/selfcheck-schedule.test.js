'use strict';
// When the self-check runs by itself: 60 s after a start (unless it ran lately) and nightly at nightlyAt in the hub's zone.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('selfcheck-schedule-iso-');
const { createScheduler } = require(path.join(ISO.lib, 'selfcheck', 'schedule.js'));

const HOUR = 3600 * 1000;
const at = (iso) => Date.parse(iso);

// A scheduler over a plain object store, a movable clock and a recorded run().
function make({ zone = 'America/New_York', settings = {}, stored = {}, now = at('2026-11-17T12:00:00Z'), running = false } = {}) {
  const st = { lastRun: null, lastNightlyDate: null, ...stored };
  const clock = { now };
  const runs = [];
  const state = { running };
  const s = { enabled: true, afterStart: true, nightlyAt: '03:45', ...settings };
  const sched = createScheduler({
    now: () => clock.now, zone: () => zone, settings: () => s,
    getStored: () => st, setStored: (p) => Object.assign(st, p),
    isRunning: () => state.running, run: (a) => { runs.push(a.trigger); return Promise.resolve(); },
  });
  return { sched, st, clock, runs, state, s };
}

test('nightly: due after nightlyAt (New York) once per local day, and not more than 3 hours late', () => {
  // 2026-11-17 is EST (UTC-5): 03:45 local is 08:45Z.
  const { sched, st, clock } = make({ stored: { lastRun: { startedAt: '2026-11-16T12:00:00Z' } } });
  clock.now = at('2026-11-17T08:44:00Z'); assert.strictEqual(sched.isDue(), false, 'a minute before');
  clock.now = at('2026-11-17T08:45:00Z'); assert.strictEqual(sched.isDue(), true, 'at nightlyAt');
  clock.now = at('2026-11-17T11:45:00Z'); assert.strictEqual(sched.isDue(), true, 'exactly 3 hours after');
  clock.now = at('2026-11-17T11:46:00Z'); assert.strictEqual(sched.isDue(), false, 'late and not stale: skip until tomorrow');
  clock.now = at('2026-11-17T09:00:00Z'); st.lastNightlyDate = '2026-11-17';
  assert.strictEqual(sched.isDue(), false, 'today already has a nightly run');
  clock.now = at('2026-11-18T08:50:00Z');
  assert.strictEqual(sched.isDue(), true, 'the next day is due again');
});

test('nightly: the hub zone decides the local date (UTC)', () => {
  const { sched, clock } = make({ zone: 'UTC', stored: { lastRun: { startedAt: '2026-11-16T12:00:00Z' } } });
  clock.now = at('2026-11-17T03:44:00Z'); assert.strictEqual(sched.isDue(), false);
  clock.now = at('2026-11-17T03:45:00Z'); assert.strictEqual(sched.isDue(), true);
  // the same instant in New York is 22:45 the evening before: not yet
  const ny = make({ zone: 'America/New_York', stored: { lastRun: { startedAt: '2026-11-16T12:00:00Z' } }, now: at('2026-11-17T03:45:00Z') });
  assert.strictEqual(ny.sched.isDue(), false);
});

test('nightly: spring-forward day (2026-03-08, New York): 03:45 is EDT, and a skipped 02:30 still runs that day', () => {
  const stored = { lastRun: { startedAt: '2026-03-07T12:00:00Z' } };
  const a = make({ stored, now: at('2026-03-08T07:44:00Z') });      // 03:44 EDT
  assert.strictEqual(a.sched.isDue(), false);
  a.clock.now = at('2026-03-08T07:45:00Z'); assert.strictEqual(a.sched.isDue(), true, '03:45 EDT');
  // 02:30 does not exist that day; the run is not lost and not early
  const b = make({ stored, settings: { nightlyAt: '02:30' }, now: at('2026-03-08T06:30:00Z') });   // 01:30 EST
  assert.strictEqual(b.sched.isDue(), false, 'before the gap');
  b.clock.now = at('2026-03-08T08:00:00Z'); assert.strictEqual(b.sched.isDue(), true, '04:00 EDT, inside the 3 hours');
});

test('nightly: fall-back day (2026-11-01, New York): the repeated 01:30 runs once', () => {
  const { sched, st, clock } = make({ settings: { nightlyAt: '01:30' }, stored: { lastRun: { startedAt: '2026-10-31T12:00:00Z' } }, now: at('2026-11-01T05:40:00Z') });   // 01:40 EDT, the first 01:30
  assert.strictEqual(sched.isDue(), true);
  st.lastNightlyDate = '2026-11-01';
  clock.now = at('2026-11-01T06:40:00Z');                            // 01:40 EST, the second one
  assert.strictEqual(sched.isDue(), false);
});

test('nightly: 23:59 is caught after midnight too, and not twice', () => {
  const { sched, st, clock } = make({ settings: { nightlyAt: '23:59' }, stored: { lastRun: { startedAt: '2026-11-17T12:00:00Z' } } });
  clock.now = at('2026-11-18T04:58:00Z'); assert.strictEqual(sched.isDue(), false, '23:58 local');
  clock.now = at('2026-11-18T04:59:00Z'); assert.strictEqual(sched.dueSlot(), '2026-11-17', '23:59 local, today\'s slot');
  clock.now = at('2026-11-18T06:30:00Z'); assert.strictEqual(sched.dueSlot(), '2026-11-17', '01:30 local: still that night\'s slot');
  st.lastNightlyDate = '2026-11-17';
  assert.strictEqual(sched.isDue(), false, 'once that slot is done, nothing is due');
  clock.now = at('2026-11-18T07:59:00Z'); assert.strictEqual(sched.isDue(), false, '02:59 local, past the 3 hours');
});

test('the 26-hour catch-up: any run counts, any hour', () => {
  const noon = at('2026-11-17T17:00:00Z');   // 12:00 local, far from nightlyAt
  const old = make({ now: noon, stored: { lastNightlyDate: '2026-11-17', lastRun: { startedAt: new Date(noon - 26.5 * HOUR).toISOString() } } });
  assert.strictEqual(old.sched.isDue(), true);
  const fresh = make({ now: noon, stored: { lastNightlyDate: '2026-11-17', lastRun: { startedAt: new Date(noon - 25.5 * HOUR).toISOString() } } });
  assert.strictEqual(fresh.sched.isDue(), false);
  const none = make({ now: noon, stored: { lastNightlyDate: '2026-11-17' } });
  assert.strictEqual(none.sched.isDue(), false, 'never run: the start run is for that, not the tick');
});

test('schedule(): a tick runs a nightly once, and respects enabled and running', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const m = make({ now: at('2026-11-17T09:00:00Z'), stored: { lastRun: { startedAt: '2026-11-16T09:00:00Z' } } });
  m.sched.schedule({ tickMs: 1000 });
  m.state.running = true; t.mock.timers.tick(1000);
  assert.deepStrictEqual(m.runs, [], 'a run in progress blocks it');
  m.state.running = false; m.s.enabled = false; t.mock.timers.tick(1000);
  assert.deepStrictEqual(m.runs, [], 'disabled');
  m.s.enabled = true; t.mock.timers.tick(1000);
  assert.deepStrictEqual(m.runs, ['nightly']);
  assert.strictEqual(m.st.lastNightlyDate, '2026-11-17');
  t.mock.timers.tick(5000);
  assert.deepStrictEqual(m.runs, ['nightly'], 'the same day does not run again');
  m.sched.stop();
  m.clock.now = at('2026-11-18T09:00:00Z'); t.mock.timers.tick(5000);
  assert.deepStrictEqual(m.runs, ['nightly'], 'stopped');
});

test('onStarted: runs 60 s later, unless it ran in the last 30 minutes, or is off', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const now = at('2026-11-17T12:00:00Z');
  const ago = (min) => ({ lastRun: { startedAt: new Date(now - min * 60000).toISOString() } });

  let m = make({ now });
  assert.strictEqual(m.sched.onStarted(), true);
  t.mock.timers.tick(59999); assert.deepStrictEqual(m.runs, []);
  t.mock.timers.tick(1); assert.deepStrictEqual(m.runs, ['start']);

  m = make({ now, stored: ago(29) });
  assert.strictEqual(m.sched.onStarted(), false, 'ran 29 minutes ago');
  t.mock.timers.tick(120000); assert.deepStrictEqual(m.runs, []);

  m = make({ now, stored: ago(30) });
  assert.strictEqual(m.sched.onStarted(), true, 'ran 30 minutes ago');
  t.mock.timers.tick(60000); assert.deepStrictEqual(m.runs, ['start']);

  m = make({ now, settings: { afterStart: false } });
  assert.strictEqual(m.sched.onStarted(), false);
  m = make({ now, settings: { enabled: false } });
  assert.strictEqual(m.sched.onStarted(), false);
  t.mock.timers.tick(120000); assert.deepStrictEqual(m.runs, []);

  m = make({ now });
  m.sched.onStarted(); m.sched.stop();
  t.mock.timers.tick(120000); assert.deepStrictEqual(m.runs, [], 'stop() clears the start timer');
});
