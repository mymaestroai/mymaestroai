'use strict';
// How the install's agents were used lately, from the model telemetry (lib/model-telemetry: the requests table), as counts only:
// per agent the requests, failures, models and tool calls; temporary workers as one line. Nothing from any conversation is read
// here, so a member's agent appears with the same counts as any other (marked "member's agent"). Used by the lead-only team_usage
// tool and by the lead's review and weekly proposal turns (lib/behaviour-review).
const fs = require('fs');

const MAX_AGENTS = 30;
const MAX_CHARS = 3000;
const TOOL_NAME = 'team_usage';
const TOOL_DESCRIPTION = 'Lead only: how agents were used over the last days (requests per agent and model, failures, temporary workers), counts only. For deciding whether a permanent worker would help.';

function adminIdsNow() {
  try { return new Set(require('./auth').getAuth().admins().map((u) => String(u.id))); } catch { return new Set(); }
}

/** Rows { agent, model, requests, failed, tool_calls } for the last `hours`, from an injected db, else the telemetry file opened read-only. [] when none. */
function readRows(hours, { db = null, dbPath = null } = {}) {
  let own = null;
  try {
    let d = db;
    if (!d) {
      const file = dbPath || require('./model-telemetry').DB_PATH;
      if (!fs.existsSync(file)) return [];
      const Database = require('better-sqlite3');
      own = new Database(file, { readonly: true, fileMustExist: true });
      d = own;
    }
    return d.prepare(`SELECT COALESCE(agent, '') AS agent, model, COUNT(*) AS requests, SUM(CASE WHEN ok = 1 THEN 0 ELSE 1 END) AS failed, COALESCE(SUM(tool_count), 0) AS tool_calls
      FROM requests WHERE ts >= datetime('now', ?) GROUP BY agent, model`).all(`-${Math.max(1, Math.floor(hours))} hours`);
  } catch { return []; } finally { if (own) { try { own.close(); } catch { /* closed */ } } }
}

const isTemporary = (name) => /^tw-/.test(String(name || ''));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
const modelList = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(([k, n]) => `${k} x${n}`).join(', ');

/** Text, at most about 3000 characters. deps: { db | dbPath, agents, adminIds }. */
function usageSummary({ hours = 168 } = {}, deps = {}) {
  const rows = readRows(hours, deps);
  let agents = deps.agents;
  if (!Array.isArray(agents)) { try { agents = require('./agents').getAgentsSync() || []; } catch { agents = []; } }
  const admins = deps.adminIds || adminIdsNow();
  const rec = (name) => agents.find((a) => a && a.name === name);
  const days = hours % 24 === 0 ? plural(hours / 24, 'day') : plural(hours, 'hour');
  const head = `Agent use over the last ${days} (counts only):`;
  // Long waits on workers (lib/long-waits): agents with two or more this week and no build partner; counts only.
  let waitLines = [];
  try {
    const lw = require('./long-waits');
    const isLeadFn = deps.isLead || ((n, a, ad) => require('./agents').isLeadAgent(n, a, ad));
    const ev = lw.evidence({ agents, file: deps.longWaitsFile, zone: deps.zone, isLead: (n) => { try { return !!isLeadFn(n, agents, admins); } catch { return true; } }, isVirtual: isTemporary });
    if (ev.length) waitLines = ['Long waits on workers (this week, no build partner):', ...ev.map((e) => `- ${e.agent}: ${e.count} times, longest ${e.longest} min (${e.dates.join(', ')})`)];
  } catch { waitLines = []; }
  if (!rows.length) return [`${head} no requests recorded.`, ...waitLines].join('\n');

  const per = new Map();     // agent -> { requests, failed, tools, models: Map }
  const temp = { runs: 0, failed: 0, models: new Map() };
  for (const r of rows) {
    const n = Number(r.requests) || 0;
    if (isTemporary(r.agent)) {
      temp.runs += n; temp.failed += Number(r.failed) || 0;
      temp.models.set(r.model, (temp.models.get(r.model) || 0) + n);
      continue;
    }
    const key = r.agent || '(unnamed)';
    const e = per.get(key) || { requests: 0, failed: 0, tools: 0, models: new Map() };
    e.requests += n; e.failed += Number(r.failed) || 0; e.tools += Number(r.tool_calls) || 0;
    e.models.set(r.model, (e.models.get(r.model) || 0) + n);
    per.set(key, e);
  }
  const ranked = [...per.entries()].sort((a, b) => b[1].requests - a[1].requests || a[0].localeCompare(b[0]));
  const lines = [head];
  for (const [name, e] of ranked.slice(0, MAX_AGENTS)) {
    const a = rec(name);
    const member = !!(a && a.owner && !admins.has(String(a.owner)));
    const tags = [a && a.category ? a.category : null, member ? "member's agent" : null].filter(Boolean);
    lines.push(`- ${name}${tags.length ? ` (${tags.join(', ')})` : ''}: ${plural(e.requests, 'request')}, ${e.failed} failed, ${plural(e.tools, 'tool call')}; models: ${modelList(e.models)}`);
  }
  if (ranked.length > MAX_AGENTS) lines.push(`and ${ranked.length - MAX_AGENTS} more`);
  if (temp.runs) lines.push(`- temporary workers: ${plural(temp.runs, 'run')}, ${temp.failed} failed; models: ${modelList(temp.models)}`);
  const waitText = waitLines.length ? `\n${waitLines.join('\n')}` : '';
  const limit = Math.max(500, MAX_CHARS - waitText.length);   // the waits section is appended after the trimmed usage lines
  let out = lines.join('\n');
  if (out.length > limit) {
    // Keep whole lines: drop agents from the bottom (the quietest), then say how many.
    const keep = [...lines];
    const tail = keep.filter((l) => l.startsWith('- temporary workers'));
    let body = keep.filter((l) => !l.startsWith('- temporary workers') && !/^and \d+ more$/.test(l));
    let cut = 0;
    const build = () => [...body, ...(cut + Math.max(0, ranked.length - MAX_AGENTS) ? [`and ${cut + Math.max(0, ranked.length - MAX_AGENTS)} more`] : []), ...tail].join('\n');
    while (body.length > 1 && build().length > limit) { body.pop(); cut++; }
    out = build().slice(0, limit);
  }
  return (out + waitText).slice(0, MAX_CHARS);
}

/** The team_usage tool body. Refuses unless the caller is an admin-side lead agent (a temporary worker counts as its parent). */
function runTeamUsage(callerName, args = {}, deps = {}) {
  let agents = deps.agents;
  if (!Array.isArray(agents)) { try { agents = require('./agents').getAgentsSync() || []; } catch { agents = []; } }
  const admins = deps.adminIds || adminIdsNow();
  let who = callerName;
  try {
    const parent = typeof deps.parentOf === 'function' ? deps.parentOf(callerName) : undefined;
    if (parent === null) return '[team_usage] Only a lead agent may use this.';       // a hub-internal check agent: no parent
    if (parent) who = parent;
  } catch { return '[team_usage] Only a lead agent may use this.'; }
  const isLead = deps.isLead || ((n, a, ad) => require('./agents').isLeadAgent(n, a, ad));
  let ok = false;
  try {
    const rec = agents.find((a) => a && a.name === who);
    ok = !!rec && (!rec.owner || admins.has(String(rec.owner))) && !!isLead(who, agents, admins);
  } catch { ok = false; }
  if (!ok) return '[team_usage] Only a lead agent may use this.';
  let days = Number(args && args.days);
  if (!Number.isFinite(days) || days < 1) days = 7;
  days = Math.min(30, Math.floor(days));
  return usageSummary({ hours: days * 24 }, { ...deps, agents, adminIds: admins });
}

module.exports = { usageSummary, runTeamUsage, TOOL_NAME, TOOL_DESCRIPTION, MAX_AGENTS, MAX_CHARS };
