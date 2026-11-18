'use strict';
// When the self-check runs on its own: 60 s after a start (unless it ran lately) and nightly at nightlyAt in the hub's zone.
const START_DELAY_MS = 60 * 1000;
const START_GAP_MS = 30 * 60 * 1000;     // a start within this long of the last run does not run again (a crash loop must not burn the plan)
const NIGHT_WINDOW_MS = 3 * 3600 * 1000; // a nightly run still starts up to this long after nightlyAt
const STALE_MS = 26 * 3600 * 1000;       // no run at all for this long: run now, whatever the clock says
const LAUNCH_GAP_MS = 60 * 60 * 1000;    // a tick never starts a run this soon after the last one this process started

const tz = () => require('../timezone');

function createScheduler({ now, zone, settings, getStored, setStored, isRunning, run, log = () => {} }) {
  let startTimer = null, tick = null;
  // In memory only: when the store can't be written, the stored dates don't hold, and a tick would start a run every time.
  let lastLaunchMs = null;
  const recentLaunch = () => lastLaunchMs !== null && now() - lastLaunchMs < LAUNCH_GAP_MS;

  // run() may throw or reject; a timer must never take the hub down
  function launch(trigger) {
    lastLaunchMs = now();
    try { Promise.resolve(run({ trigger })).catch(e => log(`[selfcheck] ${trigger} run failed: ${e && e.message}`)); }
    catch (e) { log(`[selfcheck] ${trigger} run failed: ${e && e.message}`); }
  }

  const lastStart = () => { const r = getStored().lastRun; const t = r ? Date.parse(r.startedAt) : NaN; return t > 0 ? t : null; };

  /** The instant of nightlyAt ("03:45") on a local date ("2026-11-17") in the zone. On a day that skips that wall time
   *  (clocks forward), the first moment after the gap; on a day that repeats it, the first one. */
  function slotMs(date, hm) {
    const [y, mo, d] = date.split('-').map(Number), [h, mi] = hm.split(':').map(Number);
    return tz().zonedToUtcMs(y, mo, d, h, mi, 0, zone());
  }

  /** The nightly slot (a local date) that is due at ms, or null. Today's slot and yesterday's are looked at, so a
   *  slot near midnight (23:59 plus the 3 hours) is still caught after the date turns. */
  function dueSlot(ms = now()) {
    const s = settings();
    const z = zone(), today = tz().localDate(z, ms);
    const done = getStored().lastNightlyDate || null;
    for (const date of [today, tz().addDays(today, -1)]) {
      if (!date || date === done) continue;
      const at = slotMs(date, s.nightlyAt);
      if (Number.isFinite(at) && ms >= at && ms - at <= NIGHT_WINDOW_MS) return date;
    }
    return null;
  }

  /** Is a nightly run due now? (also true for the 26-hour catch-up) */
  function isDue(ms = now()) {
    if (dueSlot(ms)) return true;
    const last = lastStart();
    return last !== null && ms - last > STALE_MS;
  }

  function onStarted() {
    const s = settings();
    if (!s.enabled || !s.afterStart) return false;
    const last = lastStart();
    if (last !== null && now() - last < START_GAP_MS) return false;
    if (startTimer) clearTimeout(startTimer);
    lastLaunchMs = now();
    startTimer = setTimeout(() => {
      startTimer = null;
      launch('start');
    }, START_DELAY_MS);
    if (startTimer.unref) startTimer.unref();
    return true;
  }

  function schedule({ tickMs = 5 * 60 * 1000 } = {}) {
    stop(true);
    const check = () => {
      try {
        if (!settings().enabled || isRunning() || recentLaunch()) return;
        const slot = dueSlot();
        if (!slot && !isDue()) return;
        if (slot) setStored({ lastNightlyDate: slot });   // before the run, so a slow run is not started twice
        else setStored({ lastNightlyDate: tz().localDate(zone(), now()) });
        launch('nightly');
      } catch (e) { log(`[selfcheck] schedule tick failed: ${e && e.message}`); }
    };
    tick = setInterval(check, tickMs);
    if (tick.unref) tick.unref();
    return check;      // returned so a test can fire a tick without waiting
  }

  function stop(keepStart = false) {
    if (tick) clearInterval(tick);
    tick = null;
    if (!keepStart && startTimer) { clearTimeout(startTimer); startTimer = null; }
  }

  return { onStarted, schedule, stop, isDue, dueSlot };
}

module.exports = { createScheduler, START_DELAY_MS, START_GAP_MS, NIGHT_WINDOW_MS, STALE_MS };
