'use strict';
/**
 * timezone.js — the time zone an agent works in, and times written in it.
 *
 * The hub stores every time in UTC. What an agent reads (the current time on each turn, search hits, recall results,
 * history stamps, summaries, session notes, schedules, the hub brief) is written in the local time of the person it
 * works for, with the zone named, so "this morning" means that person's morning.
 *
 * Whose zone: an agent with an owner uses its owner's; the hub's own agents (no owner) use the hub's zone, which is
 * the first admin's. A person's zone follows the device they use (the page reports its zone: POST /api/me/timezone)
 * unless they pinned one in their Profile. With no report yet: HUB_TZ, else this computer's zone, else UTC.
 *
 *   isZone(tz)                 a valid IANA zone name
 *   hubZone() / zoneForUser(id) / zoneForAgent(name)
 *   stamp(ts, tz)              "2026-10-28 15:47 EDT" (sortable, to the minute, zone named)
 *   shortStamp(ts, tz)         "Oct 28 15:47 EDT" (with year: "Oct 28 2026 15:47 EDT")
 *   localTimeTag(tz, now)      <local_time zone="America/New_York">Wednesday, October 28, 2026 at 3:47 PM EDT</local_time>
 *   localDate(tz, now) / localHm(tz, now)   "2026-10-28" / "15:47" in the zone
 *   parseLocal(s, tz, { endOfDay })         a time from an agent: with a zone as written, without one read in tz
 *   addDays(date, n)           "2026-10-28" + n calendar days (not 24-hour steps: a day can be 23 or 25 hours)
 *   policyText()               the system prompt's short TIME section
 */

const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)*$/;
const _valid = new Map();
function isZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64 || !ZONE_SHAPE.test(tz)) return false;
  if (_valid.has(tz)) return _valid.get(tz);
  let ok = false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); ok = true; } catch { ok = false; }
  if (_valid.size > 1000) _valid.clear();
  _valid.set(tz, ok);
  return ok;
}

function serverZone() {
  try { const z = Intl.DateTimeFormat().resolvedOptions().timeZone; if (isZone(z)) return z; } catch {}
  return 'UTC';
}

// Where users and agents come from: the hub's own modules, or stand-ins a test sets with _setDeps.
let deps = null;
function _setDeps(d) { deps = d || null; }
function authApi() { if (deps && deps.auth) return deps.auth; try { return require('./auth').getAuth(); } catch { return null; } }
function agentList() { if (deps && deps.agents) return deps.agents(); try { return require('./agents').getAgentsSync(); } catch { return []; } }
function ownerOf(rec) { if (deps && deps.ownerOf) return deps.ownerOf(rec); try { return require('./access').ownerOf(rec); } catch { return null; } }

function ownZone(user) { return user && isZone(user.timeZone) ? user.timeZone : null; }

/** The hub's zone, for its own agents: the first admin's, else HUB_TZ, else this computer's. */
function hubZone() {
  let admins = [];
  try { const a = authApi(); admins = (a && a.admins && a.admins()) || []; } catch {}
  const first = admins.slice().sort((x, y) => String(x.createdAt || '').localeCompare(String(y.createdAt || '')))[0];
  return ownZone(first) || (isZone(process.env.HUB_TZ) ? process.env.HUB_TZ : serverZone());
}

function zoneForUser(userId) {
  let u = null;
  try { const a = authApi(); u = userId && a ? a.getUser(userId) : null; } catch {}
  return ownZone(u) || hubZone();
}

function zoneForAgent(name) {
  let rec = null;
  try { rec = (agentList() || []).find(x => x && x.name === name) || null; } catch {}
  const owner = rec ? ownerOf(rec) : null;
  return owner ? zoneForUser(owner) : hubZone();
}

const _fmts = new Map();
function formatter(tz, key, opts) {
  const k = `${tz}|${key}`;
  let f = _fmts.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts });
    if (_fmts.size > 500) _fmts.clear();
    _fmts.set(k, f);
  }
  return f;
}
const zoneOr = (tz) => (isZone(tz) ? tz : 'UTC');
function toMs(ts) { const ms = typeof ts === 'number' ? ts : Date.parse(ts); return Number.isFinite(ms) ? ms : NaN; }
function partsOf(ms, tz) {
  const p = {};
  for (const x of formatter(tz, 'parts', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).formatToParts(new Date(ms))) p[x.type] = x.value;
  if (p.hour === '24') p.hour = '00';
  return p;
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-28 15:47 EDT". Something that isn't a time comes back as it was. */
function stamp(ts, tz) {
  const ms = toMs(ts);
  if (!Number.isFinite(ms)) return String(ts || '');
  const p = partsOf(ms, zoneOr(tz));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** "Oct 28 15:47 EDT", or "Oct 28 2026 15:47 EDT" with the year; '' when ts isn't a time. */
function shortStamp(ts, tz, withYear = false) {
  const ms = toMs(ts);
  if (!Number.isFinite(ms)) return '';
  const p = partsOf(ms, zoneOr(tz));
  return `${MON[Number(p.month) - 1]} ${Number(p.day)}${withYear ? ` ${p.year}` : ''} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** The zone's short name at that moment ("EDT", "PST", "GMT+5:30"). */
function zoneName(tz, now = Date.now()) { return partsOf(now, zoneOr(tz)).timeZoneName; }

/** "Wednesday, October 28, 2026 at 3:47 PM EDT" */
function longNow(tz, now = Date.now()) {
  return formatter(zoneOr(tz), 'long', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(now));
}

/** What every turn starts with: the person's local date and time, and their zone. */
function localTimeTag(tz, now = Date.now()) {
  const z = zoneOr(tz);
  return `<local_time zone="${z}">${longNow(z, now)}</local_time>`;
}

function localDate(tz, now = Date.now()) { const p = partsOf(now, zoneOr(tz)); return `${p.year}-${p.month}-${p.day}`; }
function localHm(tz, now = Date.now()) { const p = partsOf(now, zoneOr(tz)); return `${p.hour}:${p.minute}`; }

// The same wall-clock fields read as if they were UTC: wall(ms) - ms is the zone's offset at that moment.
function wallMs(ms, z) {
  const p = partsOf(ms, z);
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
}
// The moments a wall-clock time can mean in zone z: none (the hour skipped when clocks go forward), one, or two (the
// hour repeated when clocks go back), earliest first. No zone changes its offset twice within two days.
function momentsFor(want, z) {
  const before = wallMs(want - 86400000, z) - (want - 86400000);
  const after = wallMs(want + 86400000, z) - (want + 86400000);
  const fits = [...new Set([want - before, want - after])].filter(ms => wallMs(ms, z) === want).sort((a, b) => a - b);
  return { fits, skipped: want - before };
}
function validFields(y, mo, d, h, mi, s) {
  if (![y, mo, d, h, mi, s].every(Number.isInteger) || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59 || h < 0 || mi < 0 || s < 0) return false;
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDate() === d;   // no February 30
}

/**
 * Wall-clock time in a zone -> epoch ms. A time that happens twice (clocks going back) is the earlier moment; a time
 * that never happens (clocks going forward) is moved on by the gap, as the clock would show it ("02:30" on that night
 * is 03:30). NaN for an impossible date or time.
 */
function zonedToUtcMs(y, mo, d, h = 0, mi = 0, s = 0, tz = 'UTC') {
  if (!validFields(y, mo, d, h, mi, s)) return NaN;
  const { fits, skipped } = momentsFor(Date.UTC(y, mo - 1, d, h, mi, s), zoneOr(tz));
  return fits.length ? fits[0] : skipped;
}

/** "2026-10-28" + n calendar days, or null when date isn't YYYY-MM-DD. */
function addDays(date, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n)).toISOString().slice(0, 10);
}

const MON_NUM = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Zone names an agent may write that the engine's own short names don't cover, in minutes east of UTC.
const FIXED_OFFSETS = { utc: 0, gmt: 0, ut: 0, z: 0, est: -300, edt: -240, cst: -360, cdt: -300, mst: -420, mdt: -360, pst: -480, pdt: -420, akst: -540, akdt: -480, hst: -600 };
function offsetOf(tok) {
  const t = tok.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(FIXED_OFFSETS, t)) return FIXED_OFFSETS[t];
  const m = /^(?:gmt|utc)?([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(t);
  if (!m || Number(m[2]) > 14 || Number(m[3] || 0) > 59) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}
const ZONE_TOKEN = '(Z|[+-]\\d{2}:?\\d{2}|[A-Za-z][A-Za-z0-9+:\\-]*)';
const ISO_FORM = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})(?:[ T](\\d{1,2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d{1,9}))?)?)?\\s*${ZONE_TOKEN}?$`);
const MONTH_FORM = new RegExp(`^([A-Za-z]{3,9})\\.? (\\d{1,2})(?:st|nd|rd|th)?,?(?: (\\d{4}))?,?(?: (?:at )?(\\d{1,2}):(\\d{2})(?: ?([AaPp])\\.?[Mm]\\.?)?)?(?:\\s+${ZONE_TOKEN})?$`);
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * A date or time an agent wrote (recall's from/to). Read: "2026-10-28", "2026-10-28 15:47[:05[.123]]" (or with a T),
 * "Oct 28 15:47", "Oct 28 2026 15:47", "October 28, 2026", "Oct 28 3:47 PM", each optionally followed by a zone: Z,
 * +05:30, UTC, GMT+5:30, the person's own zone's short name (which also picks the moment inside a repeated hour), or
 * EST/EDT/CST/CDT/MST/MDT/PST/PDT/AKST/AKDT/HST. Without a zone it is the person's local time (tz). A bare date with
 * endOfDay means the end of that day. Anything else, an impossible date or an unknown zone gives undefined: nothing is
 * guessed, and nothing depends on this computer's zone. Returns an ISO string.
 */
function parseLocal(s, tz, { endOfDay = false } = {}) {
  if (s == null || s === '') return undefined;
  const z = zoneOr(tz);
  const str = String(s).trim().replace(/^\[(.*)\]$/, '$1');   // a history stamp copied with its brackets
  let f = null;
  let m = ISO_FORM.exec(str);
  if (m) f = { y: +m[1], mo: +m[2], d: +m[3], hasTime: m[4] !== undefined, h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0), ms: m[7] ? Math.floor(Number(`0.${m[7]}`) * 1000) : 0, tok: m[8] || '' };
  else if ((m = MONTH_FORM.exec(str)) && MONTH_NAMES[MON_NUM[m[1].slice(0, 3).toLowerCase()] - 1]?.startsWith(m[1].toLowerCase().replace(/^sept$/, 'sep'))) {
    let h = +(m[4] || 0);
    if (m[6] && (h < 1 || h > 12)) return undefined;
    if (m[6]) h = (h % 12) + (/p/i.test(m[6]) ? 12 : 0);
    f = { y: m[3] ? +m[3] : Number(partsOf(Date.now(), z).year), mo: MON_NUM[m[1].slice(0, 3).toLowerCase()], d: +m[2], hasTime: m[4] !== undefined, h, mi: +(m[5] || 0), s: 0, ms: 0, tok: m[7] || '', noYear: !m[3] };
  }
  if (!f) return undefined;
  // The moment for wall-clock fields: in the zone the token names (the person's own short name picks within a
  // repeated hour), at a fixed offset, or without a token in the person's zone. NaN for impossible fields.
  const at = (y, mo, d, h, mi, sec) => {
    if (!validFields(y, mo, d, h, mi, sec)) return NaN;
    if (!f.tok) return zonedToUtcMs(y, mo, d, h, mi, sec, z);
    const want = Date.UTC(y, mo - 1, d, h, mi, sec);
    const own = momentsFor(want, z).fits.find(ms => partsOf(ms, z).timeZoneName.toLowerCase() === f.tok.toLowerCase());
    if (own !== undefined) return own;
    const off = offsetOf(f.tok);
    return off === null ? NaN : want - off * 60000;
  };
  if (f.noYear) {
    // No year: the latest such date not ahead of now (a search looks back; two days' slack for zones ahead), decided
    // once from the date alone, so a start, an end and any time on that date name the same day.
    const probe = at(f.y, f.mo, f.d, 0, 0, 0);
    if (!Number.isFinite(probe) || probe > Date.now() + 2 * 86400000) f.y -= 1;
  }
  if (!validFields(f.y, f.mo, f.d, f.h, f.mi, f.s)) return undefined;
  let ms;
  if (!f.hasTime && endOfDay) {
    const next = addDays(`${String(f.y).padStart(4, '0')}-${String(f.mo).padStart(2, '0')}-${String(f.d).padStart(2, '0')}`, 1).split('-').map(Number);
    ms = at(next[0], next[1], next[2], 0, 0, 0) - 1;
  } else {
    ms = at(f.y, f.mo, f.d, f.h, f.mi, f.s) + f.ms;
  }
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function policyText() {
  return `\n## TIME
Each message starts with the current local date and time of the person you work for (<local_time>, or the sent= time of the current request). Times in your search hits, recall results, history, summaries, session notes and schedules are in their local time, each with its zone's short name (EDT, PST, GMT+5:30): "this morning" means their morning. When you limit a recall search, give a local date or time. Times you read in files yourself (logs, ISO strings ending in Z) are UTC.
`;
}

module.exports = {
  isZone, serverZone, hubZone, zoneForUser, zoneForAgent,
  stamp, shortStamp, zoneName, longNow, localTimeTag, localDate, localHm, zonedToUtcMs, parseLocal, addDays, policyText,
  _setDeps,
};
