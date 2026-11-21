'use strict';
// Long waits on workers: an agent that waits inside its own turn on spawn_workers or consult_agent for a long time can't talk to
// its owner meanwhile. The hub records such waits here (data/long-waits.jsonl, one JSON line each); an agent that did it twice in
// 7 days and has no build partner (agent field buildPartner) is named to the lead (hub brief line, team_usage). Information only.
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'long-waits.jsonl');
const MAX_LINES = 2000;
const KEEP_MS = 30 * 86400000;

/** Append one wait. Mode 0600; past 2000 lines the file is rewritten with the last 30 days. Never throws. */
function record({ agent, tool, minutes, at = Date.now() } = {}, { file } = {}) {
  try {
    const f = file || DEFAULT_FILE;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const line = JSON.stringify({ at: new Date(at).toISOString(), agent: String(agent || ''), tool: String(tool || ''), minutes: Number(minutes) || 0 }) + '\n';
    fs.appendFileSync(f, line, { mode: 0o600 });
    try { fs.chmodSync(f, 0o600); } catch { /* best effort */ }
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) {
      const cutoff = Date.now() - KEEP_MS;
      const keep = lines.filter((l) => { try { return Date.parse(JSON.parse(l).at) >= cutoff; } catch { return false; } });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, keep.length ? keep.join('\n') + '\n' : '', { mode: 0o600 });
      fs.renameSync(tmp, f);
    }
    return true;
  } catch (e) {
    try { console.warn('[long-waits] record failed:', e.message); } catch { /* ignore */ }
    return false;
  }
}

/** Minutes of waiting that count as long; 0 = off. Setting handOffWaitMinutes (default 10). */
function thresholdMinutes(getSetting) {
  let v; try { v = getSetting('handOffWaitMinutes', 10); } catch { v = 10; }
  if (v === undefined || v === null) v = 10;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0;
  return Math.min(240, Math.max(1, Math.round(v)));
}

/** A settings value for handOffWaitMinutes as stored: an integer 0..240; junk becomes the default 10. */
function cleanMinutes(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return 10;
  return Math.min(240, Math.max(0, Math.round(n)));
}

/** Setting buildPartnerNotice: on unless explicitly false. */
function noticeOn(getSetting) {
  try { return getSetting('buildPartnerNotice', true) !== false; } catch { return true; }
}

function readEntries(file) {
  try {
    return fs.readFileSync(file || DEFAULT_FILE, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((e) => e && typeof e.agent === 'string' && Number.isFinite(Date.parse(e.at)));
  } catch { return []; }
}

/** Agents with at least minCount long waits in the window and no build partner. */
function evidence({ hours = 168, minCount = 2, now = Date.now(), file, agents, isLead, isVirtual, zone } = {}) {
  try {
    const list = Array.isArray(agents) ? agents : [];
    const byName = new Map(list.filter((a) => a && a.name).map((a) => [a.name, a]));
    const day = zone ? new Intl.DateTimeFormat('en-CA', { timeZone: zone }) : null;
    const dayOf = (ms) => (day ? day.format(new Date(ms)) : new Date(ms).toISOString().slice(0, 10));
    const since = now - hours * 3600000;
    const groups = new Map();
    for (const e of readEntries(file)) {
      const t = Date.parse(e.at);
      if (t < since || t > now) continue;
      const name = e.agent;
      if (/^tw-/.test(name)) continue;
      const rec = byName.get(name);
      if (!rec) continue;
      if (rec.category === 'worker') continue;
      try { if (typeof isLead === 'function' && isLead(name)) continue; } catch { continue; }
      try { if (typeof isVirtual === 'function' && isVirtual(name)) continue; } catch { continue; }
      const bp = typeof rec.buildPartner === 'string' ? rec.buildPartner.trim() : '';
      if (bp && byName.has(bp)) continue;
      const g = groups.get(name) || { agent: name, count: 0, totalMinutes: 0, longest: 0, times: [] };
      const m = Number(e.minutes) || 0;
      g.count++; g.totalMinutes += m; g.longest = Math.max(g.longest, m); g.times.push(t);
      groups.set(name, g);
    }
    return [...groups.values()].filter((g) => g.count >= minCount)
      .sort((a, b) => b.count - a.count || a.agent.localeCompare(b.agent))
      .map((g) => ({ agent: g.agent, count: g.count, totalMinutes: g.totalMinutes, longest: g.longest, dates: [...new Set(g.times.sort((a, b) => a - b).map(dayOf))] }));
  } catch { return []; }
}

/** One brief line for the lead; '' when there is no evidence. */
function noticeLine(ev) {
  if (!Array.isArray(ev) || !ev.length) return '';
  const parts = ev.slice(0, 3).map((e) => `${e.agent} waited ${e.count} times on workers this week (longest ${e.longest} min, on ${e.dates.join(', ')}) and has no build partner`);
  return `- Build partners: ${parts.join('; ')}. Offer the owner a build partner for long work (hand_off), with this evidence, when it is relevant; create nothing without their yes.`;
}

module.exports = { record, thresholdMinutes, cleanMinutes, noticeOn, evidence, noticeLine, DEFAULT_FILE, MAX_LINES };
