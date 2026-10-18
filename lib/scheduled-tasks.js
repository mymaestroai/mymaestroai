'use strict';
/**
 * Hub task scheduler: one-off and recurring tasks any agent (or the owner) can set up.
 *
 * Why this exists. TASKS.md (lib/scheduler.js) only knows recurring triggers written by hand into
 * an agent's workspace. Agents had no way to say "follow up on this tomorrow at 9" and be woken for
 * it. This module keeps a persisted list of tasks; when one comes due the hub wakes the target agent
 * in a NEW turn (same path as a run_job completion) with the task text, and the agent replies in its
 * own chat.
 *
 * Guardrails.
 *  - The fired prompt is labelled as a scheduled task set by <creator>, never as the owner speaking.
 *  - The creator is recorded. Agents schedule only for themselves; the lead agent (category 'primary'
 *    in agents.json, see isPrivileged) and the owner (panel/API) may schedule for any agent. Only the
 *    creator (or the owner; the lead for tasks it did not get from the owner) may edit/cancel.
 *  - At most MAX_TASKS_PER_AGENT live (active or paused) tasks per target agent; recurring tasks may
 *    not run more often than MIN_INTERVAL_MS; one-offs at most MAX_HORIZON_DAYS ahead.
 *  - The store (data/scheduled-tasks.json) survives restarts. A task whose time passed while the hub
 *    was down fires ONCE on start-up with a "late" note; a recurring task never replays every run it
 *    missed, it fires once and moves on to its next future time.
 *  - Delivery waits while the target agent is busy (no silent skip), up to MAX_WAIT_MS.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_TZ = process.env.HUB_TZ || 'America/New_York';
const MAX_TASKS_PER_AGENT = 25;
const MIN_INTERVAL_MS = 15 * 60000;
const MAX_HORIZON_DAYS = 366;
const MAX_PROMPT = 8000;
const MAX_LABEL = 80;
const LATE_MS = 2 * 60000;          // fired more than this after its time => "late"
const MAX_WAIT_MS = 12 * 3600000;   // give up waiting for a busy agent after this
const MAX_NOTIFY_ERRORS = 10;
const RETRY_MS = 15000;
const RUNS_KEPT = 10;
const OWNER = 'owner';
const LEGACY_LEAD = 'maestro';   // default isPrivileged when none is injected
const LIVE = new Set(['active', 'paused']);

function newId() { return 'st-' + crypto.randomBytes(4).toString('hex'); }

// ── time zones (Intl, DST-correct) ───────────────────────────────────────
const _fmt = new Map();
function fmtFor(tz) {
  if (!_fmt.has(tz)) _fmt.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' }));
  return _fmt.get(tz);
}
function validTz(tz) { try { fmtFor(tz); return true; } catch { return false; } }
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
/** Wall-clock parts of instant `ms` in `tz`. */
function zonedParts(ms, tz) {
  const o = {};
  for (const p of fmtFor(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: WD[o.weekday] };
}
function tzOffsetMs(ms, tz) { const p = zonedParts(ms, tz); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; }
/** Instant of wall-clock y-mo-d h:mi in `tz`. */
function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const t = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(t, tz);
}
function fmtLocal(ms, tz = DEFAULT_TZ) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

// ── cron (5 fields, local to a time zone) ────────────────────────────────
const NAMES = {
  month: { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 },
  dow: { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 },
};
function parseField(src, lo, hi, names) {
  const out = new Set();
  for (const part of src.split(',')) {
    const m = part.match(/^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`bad cron field "${src}"`);
    const step = m[2] ? parseInt(m[2], 10) : 1;
    if (!step) throw new Error(`bad cron step in "${src}"`);
    const val = (v) => { const n = names && names[v] !== undefined ? names[v] : (/^\d+$/.test(v) ? parseInt(v, 10) : NaN); if (!(n >= lo && n <= hi)) throw new Error(`cron value "${v}" out of range ${lo}-${hi}`); return n; };
    let a = lo, b = hi;
    if (m[1] !== '*') { const [x, y] = m[1].split('-'); a = val(x); b = y === undefined ? (m[2] ? hi : a) : val(y); }
    if (a > b) throw new Error(`bad cron range "${part}"`);
    for (let i = a; i <= b; i += step) out.add(i);
  }
  return out;
}
function parseCron(expr) {
  const f = String(expr || '').trim().toLowerCase().split(/\s+/);
  if (f.length !== 5) throw new Error('a cron expression needs 5 fields: minute hour day-of-month month day-of-week');
  const dow = parseField(f[4], 0, 7, NAMES.dow);
  if (dow.has(7)) { dow.delete(7); dow.add(0); }
  return {
    minutes: [...parseField(f[0], 0, 59)].sort((a, b) => a - b),
    hours: [...parseField(f[1], 0, 23)].sort((a, b) => a - b),
    dom: parseField(f[2], 1, 31), month: parseField(f[3], 1, 12, NAMES.month), dow,
    domStar: f[2] === '*', dowStar: f[4] === '*',
  };
}
/** First run of cron `c` strictly after `afterMs`, in `tz`; null if none within ~400 days. */
function nextCronRun(c, afterMs, tz = DEFAULT_TZ) {
  if (typeof c === 'string') c = parseCron(c);
  const p = zonedParts(afterMs, tz);
  for (let i = 0; i <= 400; i++) {
    const dt = new Date(Date.UTC(p.y, p.mo - 1, p.d + i));
    const y = dt.getUTCFullYear(), mo = dt.getUTCMonth() + 1, day = dt.getUTCDate(), wd = dt.getUTCDay();
    if (!c.month.has(mo)) continue;
    const domOk = c.dom.has(day), dowOk = c.dow.has(wd);
    if (!((c.domStar || c.dowStar) ? (domOk && dowOk) : (domOk || dowOk))) continue;
    for (const h of c.hours) {
      if (i === 0 && h < p.h) continue;
      for (const m of c.minutes) {
        if (i === 0 && h === p.h && m < p.mi) continue;
        const t = zonedToUtc(y, mo, day, h, m, tz);
        if (t <= afterMs) continue;
        const q = zonedParts(t, tz);
        if (q.h !== h || q.mi !== m || q.d !== day) continue;   // wall time skipped by a DST jump
        return t;
      }
    }
  }
  return null;
}
/** Shortest gap between the next `n` runs (ms); Infinity when it runs at most once. */
function minGapMs(c, fromMs, tz, n = 60) {
  let prev = nextCronRun(c, fromMs, tz), gap = Infinity;
  for (let i = 0; i < n && prev !== null; i++) { const nx = nextCronRun(c, prev, tz); if (nx === null) break; gap = Math.min(gap, nx - prev); prev = nx; }
  return gap;
}

// ── "when" parsing ───────────────────────────────────────────────────────
const TZ_WORDS = [
  [/\b(et|est|edt|eastern(?:\s+time)?)\b/, 'America/New_York'],
  [/\b(ct|cst|cdt|central(?:\s+time)?)\b/, 'America/Chicago'],
  [/\b(pt|pst|pdt|pacific(?:\s+time)?)\b/, 'America/Los_Angeles'],
  [/\b(utc|gmt)\b/, 'UTC'],
];
const TIME_RE = '(noon|midnight|\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)|\\d{1,2}:\\d{2})';
const DAY_RE = '(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|urday|sday)?';
// Plural form ("mondays", "tuesdays"): the full day-name suffix is required, so "tues"/"thurs" are not read as "tue"+"s".
const DAYS_RE = '(sun|mon|tue|wed|thu|thur|fri|sat)(?:day|nesday|urday|sday)s';
function parseTime(s) {
  s = s.replace(/\./g, '').trim();
  if (s === 'noon') return { h: 12, m: 0 };
  if (s === 'midnight') return { h: 0, m: 0 };
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) throw new Error(`cannot read the time "${s}"`);
  let h = parseInt(m[1], 10); const mi = parseInt(m[2] || '0', 10);
  if (m[3]) { if (h < 1 || h > 12) throw new Error(`bad hour in "${s}"`); if (m[3] === 'pm' && h !== 12) h += 12; if (m[3] === 'am' && h === 12) h = 0; }
  if (h > 23 || mi > 59) throw new Error(`bad time "${s}"`);
  return { h, m: mi };
}
function dayNum(s) { return NAMES.dow[s.slice(0, 3)]; }
const WHEN_HELP = 'One-off: an ISO time ("2026-10-01T09:00:00-04:00"), "2026-10-01 09:00 ET", "in 90 minutes", "in 2 days", "tomorrow at 9am ET", "friday at 4:30 PM". Recurring: "every day at 8:15 PM ET", "weekdays at 9:00 AM", "every monday at 10am", "every 2 hours", or a 5-field cron ("15 20 * * *", evaluated in the task time zone).';

/**
 * Parse a schedule. Returns { type:'once', at, tz, text } or { type:'recurring', cron, tz, text }.
 * Throws an Error whose message is meant for the agent.
 */
function parseWhen(input, nowMs = Date.now(), defaultTz = DEFAULT_TZ) {
  const text = String(input || '').trim();
  if (!text) throw new Error('when is empty. ' + WHEN_HELP);
  // ISO instant with an explicit offset: exact.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const at = Date.parse(text); if (!Number.isFinite(at)) throw new Error(`cannot read the time "${text}"`);
    return { type: 'once', at, tz: defaultTz, text };
  }
  let s = text.toLowerCase().replace(/\s+/g, ' ');
  let tz = defaultTz;
  for (const [re, zone] of TZ_WORDS) if (re.test(s)) { tz = zone; s = s.replace(re, ' ').replace(/\s+/g, ' ').trim(); break; }
  s = s.replace(/^at /, '');
  const P = zonedParts(nowMs, tz);
  let m;
  // Cron: exactly five fields made of cron characters.
  if (/^[0-9*\/,\-a-z]+( [0-9*\/,\-a-z]+){4}$/.test(s) && /[*\d]/.test(s.split(' ')[0])) {
    const c = parseCron(s);
    return { type: 'recurring', cron: s, tz, text, _c: c };
  }
  // Relative: "in N units".
  if ((m = s.match(/^in (\d+(?:\.\d+)?) ?(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks)$/))) {
    const unit = { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[m[2][0]];
    return { type: 'once', at: nowMs + Math.round(parseFloat(m[1]) * unit), tz, text };
  }
  // Absolute local date and time.
  if ((m = s.match(new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})(?:t| | at )${TIME_RE}(?::\\d{2})?$`)))) {
    const t = parseTime(m[4]);
    return { type: 'once', at: zonedToUtc(+m[1], +m[2], +m[3], t.h, t.m, tz), tz, text };
  }
  // today / tomorrow at TIME (either order).
  if ((m = s.match(new RegExp(`^(today|tonight|tomorrow)(?: at)? ${TIME_RE}$`))) || (m = s.match(new RegExp(`^${TIME_RE} (today|tonight|tomorrow)$`)))) {
    const word = /^(today|tonight|tomorrow)$/.test(m[1]) ? m[1] : m[2];
    const t = parseTime(word === m[1] ? m[2] : m[1]);
    const add = word === 'tomorrow' ? 1 : 0;
    const d = new Date(Date.UTC(P.y, P.mo - 1, P.d + add));
    return { type: 'once', at: zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), t.h, t.m, tz), tz, text };
  }
  // Recurring natural language.
  if ((m = s.match(/^every (\d+) ?(m|min|mins|minute|minutes)$/))) {
    const n = parseInt(m[1], 10);
    if (n < 1 || n >= 60 || 60 % n) throw new Error(`"every ${n} minutes": use a divisor of 60 (15, 20, 30) or "every N hours"`);
    return { type: 'recurring', cron: `*/${n} * * * *`, tz, text };
  }
  if ((m = s.match(/^every (\d+) ?(h|hr|hrs|hour|hours)$/))) {
    const n = parseInt(m[1], 10);
    if (n < 1 || n > 23 || 24 % n) throw new Error(`"every ${n} hours": use a divisor of 24 (1, 2, 3, 4, 6, 8, 12) or "every day at …"`);
    return { type: 'recurring', cron: n === 1 ? '0 * * * *' : `0 */${n} * * *`, tz, text };
  }
  if (s === 'every hour' || s === 'hourly') return { type: 'recurring', cron: '0 * * * *', tz, text };
  if ((m = s.match(new RegExp(`^(?:every day|everyday|daily|each day)(?: at)? ${TIME_RE}$`))) || (m = s.match(new RegExp(`^${TIME_RE} (?:every day|everyday|daily)$`)))) {
    const t = parseTime(m[1]); return { type: 'recurring', cron: `${t.m} ${t.h} * * *`, tz, text };
  }
  if ((m = s.match(new RegExp(`^(?:every |on )?(weekdays?|weekends?)(?: at)? ${TIME_RE}$`)))) {
    const t = parseTime(m[2]); return { type: 'recurring', cron: `${t.m} ${t.h} * * ${m[1].startsWith('weekday') ? '1-5' : '0,6'}`, tz, text };
  }
  if ((m = s.match(new RegExp(`^every ${DAY_RE}(?: at)? ${TIME_RE}$`))) || (m = s.match(new RegExp(`^(?:on )?${DAYS_RE}(?: at)? ${TIME_RE}$`)))) {
    const t = parseTime(m[2]); return { type: 'recurring', cron: `${t.m} ${t.h} * * ${dayNum(m[1])}`, tz, text };
  }
  // One-off on a weekday: "friday at 4pm", "next monday 9am", "on tue at 10:00".
  if ((m = s.match(new RegExp(`^(?:on |next |this )?${DAY_RE}(?: at)? ${TIME_RE}$`)))) {
    const t = parseTime(m[2]); const want = dayNum(m[1]);
    for (let i = 0; i <= 7; i++) {
      const d = new Date(Date.UTC(P.y, P.mo - 1, P.d + i));
      if (d.getUTCDay() !== want) continue;
      const at = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), t.h, t.m, tz);
      if (at > nowMs) return { type: 'once', at, tz, text };
    }
  }
  // A bare time of day is ambiguous (once or daily?): refuse rather than guess.
  if (new RegExp(`^${TIME_RE}$`).test(s)) throw new Error(`"${text}" is ambiguous: say "today at ${text}" / "tomorrow at ${text}" for a one-off, or "every day at ${text}" to repeat daily.`);
  throw new Error(`cannot read the schedule "${text}". ${WHEN_HELP}`);
}

/** Validate a parsed schedule against the guardrails; returns { schedule, nextRunAt }. */
function checkSchedule(sch, nowMs) {
  if (!validTz(sch.tz)) throw new Error(`unknown time zone "${sch.tz}"`);
  if (sch.type === 'once') {
    if (!Number.isFinite(sch.at)) throw new Error('cannot read that time');
    if (sch.at <= nowMs) throw new Error(`that time (${fmtLocal(sch.at, sch.tz)}) has already passed`);
    if (sch.at - nowMs > MAX_HORIZON_DAYS * 86400000) throw new Error(`one-off tasks can be at most ${MAX_HORIZON_DAYS} days ahead`);
    return { schedule: { type: 'once', at: new Date(sch.at).toISOString(), tz: sch.tz, text: sch.text }, nextRunAt: sch.at };
  }
  const c = sch._c || parseCron(sch.cron);
  const next = nextCronRun(c, nowMs, sch.tz);
  if (next === null) throw new Error(`the schedule "${sch.text}" never runs`);
  const gap = minGapMs(c, nowMs, sch.tz);
  if (gap < MIN_INTERVAL_MS) throw new Error(`recurring tasks may run at most every ${MIN_INTERVAL_MS / 60000} minutes; "${sch.text}" runs every ${Math.round(gap / 60000)} minute(s)`);
  return { schedule: { type: 'recurring', cron: sch.cron, tz: sch.tz, text: sch.text }, nextRunAt: next };
}

class ScheduledTasks {
  /**
   * @param {object} o
   * @param {(agent:string, message:string, onReply?:(text:string)=>void, meta?:object)=>Promise<void>} o.notify
   *        wake an agent in a new turn (resolve once accepted, reject to retry); onReply gets the reply
   * @param {(agent:string)=>boolean} [o.isAgentActive]   delivery waits while this is true
   * @param {(agent:string)=>Promise<boolean>} [o.agentExists]
   * @param {(agent:string)=>boolean} [o.isPrivileged]   the lead agent(s): may schedule for and manage others
   * @param {()=>string[]} [o.leadNames]   named in the error an unprivileged agent gets
   */
  constructor(o = {}) {
    this.dataDir = o.dataDir || DEFAULT_DATA_DIR;
    this.file = path.join(this.dataDir, 'scheduled-tasks.json');
    this.notify = o.notify || (async () => {});
    this.isAgentActive = o.isAgentActive || (() => false);
    this.agentExists = o.agentExists || (async () => true);
    this.haltRefusal = o.haltRefusal || (() => null);   // non-null while the hub is halted: due tasks are not fired
    this.isPrivileged = o.isPrivileged || (agent => agent === LEGACY_LEAD);
    this.leadNames = o.leadNames || (() => [LEGACY_LEAD]);
    this.now = o.now || (() => Date.now());
    this.pollMs = o.pollMs || 20000;
    this.retryMs = o.retryMs || RETRY_MS;
    this.tz = o.tz || DEFAULT_TZ;
    this.log = o.log || ((...a) => console.log('[sched-tasks]', ...a));
    this.tasks = new Map();
    this.pending = [];   // due tasks waiting for delivery: { taskId, agent, dueAt, queuedAt, reason, attempts, notBefore }
    this._timer = null; this._busy = false; this._stopped = false;
    fs.mkdirSync(this.dataDir, { recursive: true });
    this._load();
  }

  // ── persistence ──────────────────────────────────────────────────────
  _load() {
    try {
      const doc = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const t of doc.tasks || []) this.tasks.set(t.id, t);
      for (const p of doc.pending || []) this.pending.push({ ...p, reason: p.reason || 'the hub restarted before it was delivered', notBefore: 0 });
    } catch {}
  }
  _save() {
    if (this._stopped) return;
    const doc = { tasks: [...this.tasks.values()], pending: this.pending.map(({ notBefore, ...p }) => p) };
    const tmp = this.file + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(doc, null, 1)); fs.renameSync(tmp, this.file); }
    catch (e) { this.log(`could not save scheduled tasks: ${e.message}`); }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────
  /** Queue anything that came due while the hub was down (once, marked late), then start polling. */
  start() {
    this._stopped = false;
    this._queueDue('the hub was not running at that time');
    this._save();
    if (!this._timer) {
      this._timer = setInterval(() => this.tick().catch(e => this.log('tick error:', e.message)), this.pollMs);
      if (this._timer.unref) this._timer.unref();
    }
    setTimeout(() => this.tick().catch(() => {}), 1000).unref?.();
    return this;
  }
  stop() { if (this._timer) clearInterval(this._timer); this._timer = null; this._stopped = true; }

  async tick() {
    if (this._busy || this._stopped) return; this._busy = true;
    try {
      if (this._queueDue()) this._save();
      await this._deliver();
    } finally { this._busy = false; }
  }

  /** Move due active tasks into the delivery queue. Recurring tasks advance to their next future run. */
  _queueDue(reason = null) {
    const now = this.now();
    let changed = false;
    for (const t of this.tasks.values()) {
      if (t.status !== 'active' || !t.nextRunAt) continue;
      const due = Date.parse(t.nextRunAt);
      if (due > now) continue;
      if (this.pending.some(p => p.taskId === t.id)) {
        // Still waiting to deliver the previous run: do not stack a second one.
        if (t.schedule.type === 'recurring') { t.skipped = (t.skipped || 0) + 1; this._advance(t, now); changed = true; }
        continue;
      }
      this.pending.push({ taskId: t.id, agent: t.agent, dueAt: t.nextRunAt, queuedAt: new Date(now).toISOString(), reason: now - due > LATE_MS ? (reason || 'it was overdue') : null, attempts: 0, notBefore: 0 });
      if (t.schedule.type === 'recurring') this._advance(t, now);
      else t.nextRunAt = null;
      changed = true;
    }
    return changed;
  }
  _advance(t, now) {
    try { const n = nextCronRun(parseCron(t.schedule.cron), now, t.schedule.tz); t.nextRunAt = n === null ? null : new Date(n).toISOString(); }
    catch (e) { t.nextRunAt = null; t.status = 'failed'; t.note = `bad schedule: ${e.message}`; }
  }

  async _deliver() {
    const now = this.now();
    for (const p of [...this.pending]) {
      if (this._stopped) return;
      if (p.notBefore > now) continue;
      const t = this.tasks.get(p.taskId);
      if (!t || t.status === 'cancelled') { this._unqueue(p); this._save(); continue; }
      if (this.haltRefusal()) { this._drop(p, t, 'missed', 'skipped: hub halted'); continue; }
      if (this.isAgentActive(p.agent)) {
        if (now - Date.parse(p.dueAt) > MAX_WAIT_MS) { this._drop(p, t, 'missed', `${p.agent} stayed busy for ${MAX_WAIT_MS / 3600000} h after the task was due`); continue; }
        p.notBefore = now + this.retryMs; p.waitedBusy = true; continue;
      }
      p.attempts++;
      const firedAt = new Date(this.now()).toISOString();
      const lateMs = Date.parse(firedAt) - Date.parse(p.dueAt);
      const late = lateMs > LATE_MS;
      const why = p.reason || (p.waitedBusy ? `${p.agent} was busy` : 'the hub was catching up');
      const run = { dueAt: p.dueAt, firedAt, late, lateNote: late ? `fired ${Math.round(lateMs / 60000)} min late: ${why}` : null, status: 'delivered', replyPreview: null };
      t.runs = [run, ...(t.runs || [])].slice(0, RUNS_KEPT);   // before notify, so an early onReply finds it
      try {
        await this.notify(p.agent, this.message(t, p, run), (reply) => this._onReply(t.id, firedAt, reply), { kind: 'schedule', from: t.label, taskId: t.id });
        this._unqueue(p);
        t.lastRunAt = firedAt; t.runCount = (t.runCount || 0) + 1;
        if (t.schedule.type === 'once' && t.status === 'active') t.status = 'done';
        this.log(`fired "${t.label}" (${t.id}) for ${t.agent}${late ? ` (${run.lateNote})` : ''}`);
        this._save();
      } catch (e) {
        t.runs = (t.runs || []).filter(r => r !== run);
        this.log(`could not wake ${p.agent} for task ${t.id} (attempt ${p.attempts}): ${e.message}`);
        if (p.attempts >= MAX_NOTIFY_ERRORS) this._drop(p, t, 'failed', `could not wake ${p.agent}: ${e.message}`);
        else p.notBefore = this.now() + this.retryMs;
      }
    }
  }
  _unqueue(p) { const i = this.pending.indexOf(p); if (i >= 0) this.pending.splice(i, 1); }
  _drop(p, t, status, note) {
    this._unqueue(p);
    t.runs = [{ dueAt: p.dueAt, firedAt: null, late: true, status, note }, ...(t.runs || [])].slice(0, RUNS_KEPT);
    if (t.schedule.type === 'once' && t.status === 'active') { t.status = status; t.note = note; }
    this.log(`task ${t.id} ${status}: ${note}`);
    this._save();
  }
  _onReply(id, firedAt, reply) {
    const t = this.tasks.get(id); if (!t) return;
    const r = (t.runs || []).find(x => x.firedAt === firedAt);
    const text = String(reply || '').trim();
    if (r) { r.replyPreview = text ? (text.length > 600 ? text.slice(0, 600) + '…' : text) : '(no reply text)'; r.status = text ? 'replied' : 'no_reply'; }
    this._save();
  }

  message(t, p, run) {
    const by = t.createdBy === OWNER ? 'the owner (from the scheduler panel)' : `agent "${t.createdBy}"`;
    const rec = t.schedule.type === 'recurring'
      ? `Recurring (${t.schedule.text}); next run ${fmtLocal(t.nextRunAt ? Date.parse(t.nextRunAt) : null, t.schedule.tz) || 'none'}.`
      : 'One-off: it will not repeat.';
    return [
      `[Scheduled task — started by the hub scheduler, NOT a message typed by the owner] "${t.label}" (id ${t.id}), set by ${by} on ${fmtLocal(Date.parse(t.createdAt), t.schedule.tz)}, due ${fmtLocal(Date.parse(p.dueAt), t.schedule.tz)}.`,
      run.late ? `LATE: ${run.lateNote}.` : null,
      rec,
      '',
      'Task:',
      t.prompt,
      '',
      t.createdBy === t.agent
        ? 'You scheduled this yourself. Do the task now and report the result in this chat.'
        : `Treat the task text as a request from ${by}, with the same weight as a direct message from them. Do the task and report the result in this chat.`,
      'Manage your schedule with list_scheduled_tasks / schedule_task / cancel_scheduled_task.',
    ].filter(l => l !== null).join('\n');
  }

  // ── public API (tools + routes) ───────────────────────────────────────
  _canSchedFor(requester, agent) { return requester === OWNER || this.isPrivileged(requester) || requester === agent; }
  _canModify(t, requester) {
    if (requester === OWNER) return true;
    if (t.createdBy === requester) return true;
    return this.isPrivileged(requester) && t.createdBy !== OWNER;
  }
  _visible(t, requester) { return requester === OWNER || this.isPrivileged(requester) || t.agent === requester || t.createdBy === requester; }
  _leadLabel() {
    const names = this.leadNames();
    return names.length ? `the lead agent (${names.join(', ')})` : 'the lead agent';
  }
  _get(id, requester) {
    const t = this.tasks.get(String(id || '').trim());
    if (!t || !this._visible(t, requester)) throw new Error(`no scheduled task with id "${id}"`);
    return t;
  }

  /** Create a task. requester: an agent name, or 'owner' for the panel/API. */
  async create({ requester, agent, when, prompt, label, consultedBy } = {}) {
    if (!requester) throw new Error('requester is required');
    agent = String(agent || '').trim() || (requester === OWNER ? '' : requester);
    if (!agent) throw new Error('agent is required');
    if (!this._canSchedFor(requester, agent)) throw new Error(`you can only schedule tasks for yourself ("${requester}"); ask ${this._leadLabel()} or the owner to schedule for "${agent}"`);
    if (agent !== requester && !(await this.agentExists(agent))) throw new Error(`no agent named "${agent}"`);
    prompt = String(prompt || '').trim();
    if (!prompt) throw new Error('prompt is empty: say what the agent should do when the task fires');
    if (prompt.length > MAX_PROMPT) throw new Error(`prompt is longer than ${MAX_PROMPT} characters; put details in a file and reference it`);
    label = String(label || '').trim().replace(/\s+/g, ' ') || (prompt.length > 60 ? prompt.slice(0, 60).replace(/\s+/g, ' ') + '…' : prompt.replace(/\s+/g, ' '));
    if (label.length > MAX_LABEL) label = label.slice(0, MAX_LABEL - 1) + '…';
    const live = [...this.tasks.values()].filter(t => t.agent === agent && LIVE.has(t.status));
    if (live.length >= MAX_TASKS_PER_AGENT) throw new Error(`"${agent}" already has ${live.length} live scheduled tasks (limit ${MAX_TASKS_PER_AGENT}); cancel some first`);
    const now = this.now();
    const { schedule, nextRunAt } = checkSchedule(parseWhen(when, now, this.tz), now);
    let id = newId(); while (this.tasks.has(id)) id = newId();
    const t = {
      id, agent, createdBy: requester, consultedBy: consultedBy || null, createdAt: new Date(now).toISOString(),
      label, prompt, schedule, status: 'active', nextRunAt: new Date(nextRunAt).toISOString(),
      lastRunAt: null, runCount: 0, runs: [],
    };
    this.tasks.set(id, t);
    this._save();
    this.log(`${requester} scheduled "${label}" (${id}) for ${agent}: ${schedule.text} -> ${t.nextRunAt}`);
    return this.view(t);
  }

  /** Edit label / prompt / when (and target agent, owner or lead agent only). */
  async update(id, requester, { when, prompt, label, agent } = {}) {
    const t = this._get(id, requester);
    if (!this._canModify(t, requester)) throw new Error(`only ${t.createdBy === OWNER ? 'the owner' : `"${t.createdBy}" (who created it) or the owner`} can change task ${t.id}`);
    if (!LIVE.has(t.status) && when === undefined) throw new Error(`task ${t.id} is ${t.status}; give a new "when" to re-arm it`);
    const next = { ...t };
    if (agent !== undefined && String(agent).trim() && String(agent).trim() !== t.agent) {
      agent = String(agent).trim();
      if (!this._canSchedFor(requester, agent)) throw new Error('you can only schedule tasks for yourself');
      if (!(await this.agentExists(agent))) throw new Error(`no agent named "${agent}"`);
      if ([...this.tasks.values()].filter(x => x.agent === agent && LIVE.has(x.status)).length >= MAX_TASKS_PER_AGENT) throw new Error(`"${agent}" already has ${MAX_TASKS_PER_AGENT} live scheduled tasks`);
      next.agent = agent;
    }
    if (prompt !== undefined) { prompt = String(prompt).trim(); if (!prompt) throw new Error('prompt is empty'); if (prompt.length > MAX_PROMPT) throw new Error(`prompt is longer than ${MAX_PROMPT} characters`); next.prompt = prompt; }
    if (label !== undefined && String(label).trim()) next.label = String(label).trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL);
    if (when !== undefined && String(when).trim()) {
      const now = this.now();
      const { schedule, nextRunAt } = checkSchedule(parseWhen(when, now, this.tz), now);
      next.schedule = schedule; next.nextRunAt = new Date(nextRunAt).toISOString();
      if (!LIVE.has(t.status)) next.status = 'active';
      this.pending = this.pending.filter(p => p.taskId !== t.id);
    }
    next.updatedAt = new Date(this.now()).toISOString(); next.updatedBy = requester;
    this.tasks.set(t.id, next);
    this._save();
    return this.view(next);
  }

  /** pause | resume | cancel | delete | run_now */
  action(id, requester, action) {
    const t = this._get(id, requester);
    if (!this._canModify(t, requester)) throw new Error(`only ${t.createdBy === OWNER ? 'the owner' : `"${t.createdBy}" (who created it) or the owner`} can ${action} task ${t.id}`);
    const now = this.now();
    switch (action) {
      case 'pause': if (t.status !== 'active') throw new Error(`task ${t.id} is ${t.status}`); t.status = 'paused'; this.pending = this.pending.filter(p => p.taskId !== t.id); break;   // a run already queued is dropped, not delivered
      case 'resume':
        if (t.status !== 'paused') throw new Error(`task ${t.id} is ${t.status}`);
        t.status = 'active';
        if (t.schedule.type === 'recurring') this._advance(t, now);   // do not replay runs missed while paused
        else if (!t.nextRunAt) t.nextRunAt = t.schedule.at;          // a paused one-off whose time passed fires once, late
        break;
      case 'cancel': if (!LIVE.has(t.status)) throw new Error(`task ${t.id} is already ${t.status}`); t.status = 'cancelled'; t.nextRunAt = null; this.pending = this.pending.filter(p => p.taskId !== t.id); break;
      case 'delete': this.tasks.delete(t.id); this.pending = this.pending.filter(p => p.taskId !== t.id); this._save(); return { id: t.id, deleted: true };
      case 'run_now':
        if (this.pending.some(p => p.taskId === t.id)) throw new Error(`task ${t.id} is already waiting to be delivered`);
        this.pending.push({ taskId: t.id, agent: t.agent, dueAt: new Date(now).toISOString(), queuedAt: new Date(now).toISOString(), reason: null, attempts: 0, notBefore: 0, manual: true });
        if (t.schedule.type === 'once' && t.status === 'active') t.nextRunAt = null;
        break;
      default: throw new Error(`unknown action "${action}" (pause, resume, cancel, delete, run_now)`);
    }
    t.updatedAt = new Date(now).toISOString(); t.updatedBy = requester;
    this._save();
    return this.view(t);
  }

  view(t) {
    const tz = t.schedule.tz;
    return {
      id: t.id, agent: t.agent, label: t.label, createdBy: t.createdBy, consultedBy: t.consultedBy || undefined, createdAt: t.createdAt,
      status: t.status, schedule: t.schedule.type === 'once' ? `once at ${fmtLocal(Date.parse(t.schedule.at), tz)}` : `${t.schedule.text} (cron "${t.schedule.cron}", ${tz})`,
      type: t.schedule.type, when: t.schedule.type === 'once' ? t.schedule.at : t.schedule.text, nextRunAt: t.nextRunAt, nextRunLocal: t.nextRunAt ? fmtLocal(Date.parse(t.nextRunAt), tz) : null,
      queued: this.pending.some(p => p.taskId === t.id) || undefined,
      lastRunAt: t.lastRunAt, updatedAt: t.updatedAt || undefined, runCount: t.runCount || 0, skipped: t.skipped || undefined, note: t.note || undefined,
      prompt: t.prompt, lastRun: (t.runs || [])[0] || null,
    };
  }

  list(requester, { includeDone = true } = {}) {
    const order = { active: 0, paused: 1, done: 2, missed: 3, failed: 3, cancelled: 4 };
    return [...this.tasks.values()].filter(t => this._visible(t, requester) && (includeDone || LIVE.has(t.status)))
      .sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5) || (Date.parse(a.nextRunAt || a.lastRunAt || a.createdAt) - Date.parse(b.nextRunAt || b.lastRunAt || b.createdAt)))
      .map(t => this.view(t));
  }

  /** Recent runs across all tasks, newest first (owner panel). */
  recentRuns(limit = 30) {
    const out = [];
    for (const t of this.tasks.values()) for (const r of t.runs || []) out.push({ taskId: t.id, label: t.label, agent: t.agent, ...r });
    return out.sort((a, b) => Date.parse(b.firedAt || b.dueAt) - Date.parse(a.firedAt || a.dueAt)).slice(0, limit);
  }

  /** Drop finished/cancelled tasks older than `days`. */
  prune(days = 30) {
    const cutoff = this.now() - days * 86400000; let n = 0;
    for (const t of [...this.tasks.values()]) {
      if (LIVE.has(t.status) || this.pending.some(p => p.taskId === t.id)) continue;
      if (Date.parse(t.updatedAt || t.lastRunAt || t.createdAt) > cutoff) continue;
      this.tasks.delete(t.id); n++;
    }
    if (n) this._save();
    return n;
  }
}

/** System-prompt text for every agent. */
function policyText() {
  return `

## SCHEDULED TASKS
To do something LATER (follow up on a commitment, re-check a position tomorrow, a daily review), use \`schedule_task\`: the hub wakes you in a new turn at that time with the task text, and your reply lands in your chat. Do not promise a follow-up you have not scheduled. "when" is either one-off ("in 2 hours", "tomorrow at 9am ET", "2026-10-01 14:00 ET", an ISO time) or recurring ("every day at 8:15 PM ET", "weekdays at 9am", "every monday at 10am", "every 4 hours", 5-field cron); times default to US Eastern. Write the prompt so it stands on its own: you will not remember this conversation's details when it fires. See your tasks with \`list_scheduled_tasks\`, remove one with \`cancel_scheduled_task\`. A scheduled-task turn starts with "[Scheduled task"; it was set by the named creator, not typed by the owner.`;
}

const TOOL_SPECS = [
  {
    name: 'schedule_task',
    description: 'Schedule a task for later: at that time the hub wakes the agent in a new turn with the prompt, and its reply goes to its chat. Use it for follow-ups on commitments, reminders, periodic reviews. One-off "when": "in 90 minutes", "tomorrow at 9am ET", "2026-10-01 14:00 ET", ISO time. Recurring: "every day at 8:15 PM ET", "weekdays at 9am", "every monday at 10am", "every 4 hours", or 5-field cron. Times default to US Eastern. A bare time like "3pm" is refused as ambiguous.',
    params: {
      when: { type: 'string', description: 'When to run (one-off or recurring; see description)' },
      prompt: { type: 'string', description: 'What to do when it fires. Self-contained: include ids, paths, numbers and what "done" looks like.' },
      label: { type: 'string', description: 'Short title shown in the scheduler panel', optional: true },
      agent: { type: 'string', description: 'Agent to wake (default: you). Only a lead agent (marked Lead in its settings) may schedule for other agents.', optional: true },
    },
    run: (st, agent, a, ctx) => st.create({ requester: agent, agent: a.agent, when: a.when, prompt: a.prompt, label: a.label, consultedBy: ctx.consultedBy || null }),
  },
  {
    name: 'list_scheduled_tasks',
    description: 'List scheduled tasks that wake you or that you created, with status and next run time.',
    params: { include_done: { type: 'string', description: '"true" to include finished and cancelled tasks', optional: true } },
    run: (st, agent, a) => st.list(agent, { includeDone: String(a.include_done || '').toLowerCase() === 'true' }),
  },
  {
    name: 'cancel_scheduled_task',
    description: 'Cancel a scheduled task you created (by id from list_scheduled_tasks).',
    params: { id: { type: 'string', description: 'Task id (st-…)' } },
    run: (st, agent, a) => st.action(a.id, agent, 'cancel'),
  },
];

async function runTool(st, spec, agent, args, ctx = {}) {
  try { return JSON.stringify(await spec.run(st, agent, args || {}, ctx), null, 1); }
  catch (e) { return `[${spec.name} error] ${e.message}`; }
}

let _inst = null;
function getScheduledTasks(opts) { if (!_inst) _inst = new ScheduledTasks(opts); return _inst; }

module.exports = {
  ScheduledTasks, getScheduledTasks, policyText, TOOL_SPECS, runTool,
  parseWhen, checkSchedule, parseCron, nextCronRun, zonedParts, zonedToUtc, fmtLocal,
  OWNER, MAX_TASKS_PER_AGENT, MIN_INTERVAL_MS, DEFAULT_TZ,
};
