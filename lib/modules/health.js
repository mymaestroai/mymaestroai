'use strict';
/**
 * Nightly health check of data connectors (modules): every module that is switched on and declares health.check in
 * module.json has that check run once a night (the hub's night window, or at any hour once the last look is 48 hours
 * old). When a check goes from passing (or never run) to failing, the admins get ONE phone notice; a notice that did
 * not reach a device is tried again on the next hourly tick; a passing check clears the marker. Modelled on
 * lib/memory-health. A module whose last check failed no longer shows as "ready" (it shows "attention"), so a module
 * this file saw failing keeps being checked until it passes again.
 * State: data/modules-health.json { checkedAt, results: { <id>: { ok, summary, at } }, notified: [ids] } (mode 0600).
 */

const fs = require('fs');
const path = require('path');
const { hourIn, dateIn, NIGHT } = require('../memory-health');

const HOUR = 3600000;
const FILE = path.join(__dirname, '..', '..', 'data', 'modules-health.json');

function createModulesHealth({
  modules,
  push,
  clock = Date.now,
  file = FILE,
  hubZone = () => 'UTC',
  log = (...a) => console.log(...a),
} = {}) {
  if (!modules) throw new Error('modules health needs the modules');
  let running = null, timer = null, first = null;

  function read() {
    try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return s && typeof s === 'object' ? s : {}; } catch { return {}; }
  }
  function write(s) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  const zone = () => { try { return hubZone() || 'UTC'; } catch { return 'UTC'; } };

  /** Due: never looked, 48 hours since the last look, or (in the night window) no look yet on this calendar day; also
   *  when a failure notice has not reached a device yet. */
  function isDue(ms = clock()) {
    const s = read();
    const at = Date.parse(s.checkedAt);
    if (!(at > 0)) return true;
    const notified = new Set(s.notified || []);
    if (Object.entries(s.results || {}).some(([id, r]) => r && r.ok === false && !notified.has(id))) return true;
    if (ms - at >= 48 * HOUR) return true;
    const z = zone(), h = hourIn(z, ms);
    return h >= NIGHT[0] && h < NIGHT[1] && dateIn(z, at) !== dateIn(z, ms);
  }

  async function runOnce() {
    const before = read();
    const results = { ...(before.results || {}) };
    const notified = new Set(before.notified || []);
    let list = []; try { list = modules.list(); } catch (e) { log(`[modules-health] ${e.message}`); }
    for (const x of list) {
      const seenFailing = results[x.id] && results[x.id].ok === false;
      if (!x.health || !(x.state === 'ready' || (x.state === 'attention' && seenFailing))) continue;
      let checkName = null;
      try { checkName = modules.detail(x.id).manifest.health.check; } catch {}
      let r;
      try {
        if (!checkName) throw new Error('its health check is not set');
        const c = await modules.check(x.id, checkName);
        r = { ok: !!c.ok, summary: String(c.summary || (c.ok ? 'OK' : 'Failed')) };
      } catch (e) { r = { ok: false, summary: String((e && e.message) || e) }; }
      results[x.id] = { ok: r.ok, summary: r.summary.slice(0, 500), at: new Date(clock()).toISOString() };
      if (r.ok) { notified.delete(x.id); continue; }
      if (notified.has(x.id)) continue;
      try {
        const n = await push.notify({ title: `${x.name} needs attention`, body: r.summary.slice(0, 160), url: `/modules#${x.id}`, tag: `module-health-${x.id}` }, { adminsOnly: true });
        if (!(n && (n.error || (n.sent === 0 && n.failed > 0)))) notified.add(x.id);
      } catch (e) { log(`[modules-health] notice failed: ${e.message}`); }
    }
    const out = { checkedAt: new Date(clock()).toISOString(), results, notified: [...notified] };
    write(out);
    return out;
  }
  /** One pass over every module that qualifies, one at a time. Calls while a pass runs share it. */
  function run() {
    if (!running) running = runOnce().finally(() => { running = null; });
    return running;
  }

  /** Look every hour whether the nightly check is due (the first look a few minutes after start). */
  function start({ tickMs = HOUR, firstDelayMs = 5 * 60 * 1000 } = {}) {
    stop();
    const tick = () => { if (isDue()) run().catch(e => log(`[modules-health] check failed: ${e.message}`)); };
    first = setTimeout(tick, firstDelayMs); if (first.unref) first.unref();
    timer = setInterval(tick, tickMs); if (timer.unref) timer.unref();
    return true;
  }
  function stop() { if (first) clearTimeout(first); if (timer) clearInterval(timer); first = timer = null; }

  return { run, isDue, start, stop, state: read };
}

let shared = null;
function getModulesHealth() {
  if (!shared) {
    shared = createModulesHealth({
      modules: require('./index').getModules(),
      push: { notify: (p, o) => require('../push').getPush().notify(p, o) },
      hubZone: () => require('../timezone').hubZone(),
    });
  }
  return shared;
}

module.exports = { createModulesHealth, getModulesHealth };
