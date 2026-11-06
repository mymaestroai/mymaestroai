'use strict';
// MCP stdio server (newline-delimited JSON-RPC) that lets agents read Oura Ring data. Read-only.
// A rotated refresh token is announced to the hub with a JSON-RPC notification on stdout; it is never logged.

const { createOura } = require('./oura');

const DAY = 24 * 3600 * 1000;
const MAX_DAYS = 31;            // inclusive days in one request
const DEFAULT_DAYS = 7;
const MAX_HR_SPAN = 7 * DAY;
const DEFAULT_HR_SPAN = DAY;
const MAX_HR_POINTS = 500;
const P = '/v2/usercollection/';

const dateProps = {
  start_date: { type: 'string', description: 'First day, YYYY-MM-DD. Default: 6 days before end_date.' },
  end_date: { type: 'string', description: 'Last day, YYYY-MM-DD. Default: today. At most 31 days from start_date to end_date.' },
};
const dayTool = (name, description) => ({ name, description, inputSchema: { type: 'object', properties: dateProps } });
const TOOLS = [
  dayTool('oura_sleep', 'Sleep per night: score, total/deep/REM/light minutes, efficiency, heart rate, HRV and latency.'),
  dayTool('oura_readiness', 'Daily readiness: score, temperature deviation and contributors.'),
  dayTool('oura_activity', 'Daily activity: score, steps, active and total calories, inactivity alerts.'),
  { name: 'oura_heart_rate', description: 'Heart rate readings (at most 500 points, thinned evenly): timestamp, bpm and source.',
    inputSchema: { type: 'object', properties: {
      start: { type: 'string', description: 'Start, ISO 8601 date-time. Default: 24 hours before end.' },
      end: { type: 'string', description: 'End, ISO 8601 date-time. Default: now. At most 7 days from start.' } } } },
  dayTool('oura_spo2', 'Daily average blood oxygen (SpO2) percentage.'),
  dayTool('oura_workouts', 'Workouts: date, activity, start, end, calories, distance and intensity.'),
];

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

function parseDay(v, key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v));
  const ms = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  if (!Number.isFinite(ms) || iso(ms) !== v) throw new Error(`"${key}" must be a date like 2026-11-06.`);
  return ms;
}

function dayRange(args, now) {
  const given = (k) => args[k] !== undefined && args[k] !== null && args[k] !== '';
  const endMs = given('end_date') ? parseDay(args.end_date, 'end_date') : parseDay(iso(now()), 'end_date');
  const startMs = given('start_date') ? parseDay(args.start_date, 'start_date') : endMs - (DEFAULT_DAYS - 1) * DAY;
  if (endMs < startMs) throw new Error('"end_date" must not be before "start_date".');
  if ((endMs - startMs) / DAY + 1 > MAX_DAYS) throw new Error(`Ask for at most ${MAX_DAYS} days at a time.`);
  return { start_date: iso(startMs), end_date: iso(endMs) };
}

function parseTime(v, key) {
  const s = String(v);
  const ms = /^\d{4}-\d{2}-\d{2}T/.test(s) ? Date.parse(s) : NaN;
  if (!Number.isFinite(ms)) throw new Error(`"${key}" must be an ISO date-time like 2026-11-06T08:00:00Z.`);
  return ms;
}

function timeRange(args, now) {
  const given = (k) => args[k] !== undefined && args[k] !== null && args[k] !== '';
  const endMs = given('end') ? parseTime(args.end, 'end') : now();
  const startMs = given('start') ? parseTime(args.start, 'start') : endMs - DEFAULT_HR_SPAN;
  if (endMs < startMs) throw new Error('"end" must not be before "start".');
  if (endMs - startMs > MAX_HR_SPAN) throw new Error('Ask for at most 7 days of heart rate at a time.');
  return { start_datetime: new Date(startMs).toISOString(), end_datetime: new Date(endMs).toISOString() };
}

const mins = (sec) => (Number.isFinite(sec) ? Math.round(sec / 60) : null);
const val = (v) => (v === undefined ? null : v);
const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

function thin(points, max = MAX_HR_POINTS) {
  if (points.length <= max) return points;
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor((i * (points.length - 1)) / (max - 1))]);
  return out;
}

async function sleep(oura, range) {
  const [daily, periods] = await Promise.all([oura.get(`${P}daily_sleep`, range), oura.get(`${P}sleep`, range)]);
  const score = new Map(daily.map((d) => [d.day, d.score]));
  const seen = new Set();
  const rows = periods.map((s) => {
    seen.add(s.day);
    return {
      date: s.day, score: val(score.get(s.day)), type: val(s.type),
      total_min: mins(s.total_sleep_duration), deep_min: mins(s.deep_sleep_duration), rem_min: mins(s.rem_sleep_duration), light_min: mins(s.light_sleep_duration),
      efficiency: val(s.efficiency), avg_heart_rate: val(s.average_heart_rate), lowest_heart_rate: val(s.lowest_heart_rate),
      avg_hrv: val(s.average_hrv), latency_min: mins(s.latency),
    };
  });
  for (const d of daily) if (!seen.has(d.day)) rows.push({ date: d.day, score: val(d.score) });
  return { range, nights: rows.sort(byDate) };
}

const readers = {
  oura_sleep: sleep,
  async oura_readiness(oura, range) {
    const data = await oura.get(`${P}daily_readiness`, range);
    return { range, days: data.map((d) => ({ date: d.day, score: val(d.score), temperature_deviation: val(d.temperature_deviation), contributors: val(d.contributors) })).sort(byDate) };
  },
  async oura_activity(oura, range) {
    const data = await oura.get(`${P}daily_activity`, range);
    return { range, days: data.map((d) => ({ date: d.day, score: val(d.score), steps: val(d.steps), active_calories: val(d.active_calories), total_calories: val(d.total_calories), inactivity_alerts: val(d.inactivity_alerts) })).sort(byDate) };
  },
  async oura_spo2(oura, range) {
    const data = await oura.get(`${P}daily_spo2`, range);
    return { range, days: data.map((d) => ({ date: d.day, average_percentage: d.spo2_percentage && d.spo2_percentage.average !== undefined ? d.spo2_percentage.average : null })).sort(byDate) };
  },
  async oura_workouts(oura, range) {
    const data = await oura.get(`${P}workout`, range);
    return { range, workouts: data.map((w) => ({ date: w.day, activity: val(w.activity), start: val(w.start_datetime), end: val(w.end_datetime), calories: val(w.calories), distance: val(w.distance), intensity: val(w.intensity) })).sort(byDate) };
  },
  async oura_heart_rate(oura, range) {
    const data = await oura.get(`${P}heartrate`, range);
    const all = data.filter((d) => d && d.timestamp).sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
    const points = thin(all).map((d) => ({ timestamp: d.timestamp, bpm: val(d.bpm), source: val(d.source) }));
    return { range, total_readings: all.length, points };
  },
};

async function callTool(oura, name, args, now) {
  args = args && typeof args === 'object' ? args : {};
  const range = name === 'oura_heart_rate' ? timeRange(args, now) : dayRange(args, now);
  return readers[name](oura, range);
}

// One JSON-RPC message in -> the reply object, or null for notifications.
async function handle(msg, oura, now = Date.now) {
  if (!msg || typeof msg !== 'object') return null;
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (id === undefined || id === null) return null;   // notifications get no reply
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'oura', version: '1.0.0' } });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = params && params.name;
      if (!TOOLS.some((t) => t.name === name)) return error(-32602, 'Unknown tool.');
      try {
        const out = await callTool(oura, name, params.arguments, now);
        return reply({ content: [{ type: 'text', text: JSON.stringify(out) }] });
      } catch (e) {
        return reply({ isError: true, content: [{ type: 'text', text: String((e && e.message) || 'Something went wrong.') }] });
      }
    }
    default: return error(-32601, 'Method not found.');
  }
}

// The hub saves the new refresh token from this notification. Never log it.
const rotationNotice = (value) => JSON.stringify({ jsonrpc: '2.0', method: 'notifications/hub/refresh_token', params: { value } }) + '\n';
const onRotate = (value) => { process.stdout.write(rotationNotice(value)); };

function main() {
  const oura = createOura({ clientId: process.env.CLIENT_ID, clientSecret: process.env.CLIENT_SECRET, refreshToken: process.env.REFRESH_TOKEN, onRotate });
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      handle(msg, oura).then((r) => { if (r) process.stdout.write(JSON.stringify(r) + '\n'); });
    }
  });
}

if (require.main === module) main();

module.exports = { handle, TOOLS, thin, rotationNotice, onRotate };
