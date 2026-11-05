'use strict';
// Records: per-agent documents the hub loads IN FULL into the agent's context on every turn. They are
// the agent's source of truth (a patient summary, a matter file, a job file, open positions, standing
// rules), never searched for relevance, never trimmed, never summarised by a provider. The agent keeps
// them current with record_write; the owner can read and edit them on the agent's settings page.
//
// Folder: workspaces/<agent>/records/*.md (symlinks allowed, so a file that already lives elsewhere, like
// medical/patients/pat.md, can be a record without moving). Size cap per agent: agents.json
// `recordsMaxBytes`, else settings.recordsMaxBytes, else 256 KB. Files load in name order, except the working brief
// (lib/compaction's carry-forward), which always loads first; a file that would pass the cap is not loaded and the
// agent is told which ones. From 75% of the cap the agent is told to condense them (lib/memory-health shows the same).

const fs = require('fs');
const path = require('path');

const HUB_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MAX = 256 * 1024;
const BRIEF = 'working-brief.md';   // lib/compaction BRIEF_FILE
const WARN_AT = 0.75;   // share of the cap at which the agent is told to condense its Records

function folderFor(agentName) { return path.join(HUB_ROOT, 'workspaces', String(agentName), 'records'); }
function cleanName(name) {
  let n = String(name || '').replace(/[\\/\0]/g, '').replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!n || n.startsWith('.')) return null;
  if (!/\.(md|txt)$/i.test(n)) n += '.md';
  return n.slice(0, 120);
}

function maxBytesFor(agentName, { agentRecord = null } = {}) {
  let v = agentRecord && Number(agentRecord.recordsMaxBytes);
  if (!(v > 0)) { try { v = Number(require('./settings').getSetting('recordsMaxBytes', 0)); } catch { v = 0; } }
  return v > 0 ? v : DEFAULT_MAX;
}

// The cap an agent's Records really load under. The Claude and ChatGPT clients load them under the agent's own cap;
// every other model goes through the hub's prompt budget (lib/context-budget), which gives Records at most 30% of the
// model's window, so a small window means a smaller cap.
//   loadCap (the agent's own replies, inside a turn): the cap of this agent's last prompt, while its model is the same;
//     else worked out from the window known without asking a server.
//   routeCap (lib/memory-health): worked out now exactly as the gateway does before a turn, asking LM Studio or NInfer
//     for the loaded window; estimated: true when such a server didn't answer.
const CLIENT_ROUTE = /^(claude-sdk|codex-cli)\//i;
const capSeen = new Map();   // agent -> { cap, model }
function loadCap(agentName, { agentRecord = null } = {}) {
  const model = String((agentRecord && agentRecord.model) || '');
  const seen = capSeen.get(String(agentName));
  if (seen && seen.model === model) return seen.cap;
  const cap = maxBytesFor(agentName, { agentRecord });
  if (!model || CLIENT_ROUTE.test(model)) return cap;
  try { const cb = require('./context-budget'); return cb.plan(cb.windowForAgentSync(agentRecord, model), { recordsCapBytes: cap }).recordsBytes; }
  catch { return cap; }
}
async function routeCap(agentName, { agentRecord = null } = {}) {
  const own = maxBytesFor(agentName, { agentRecord });
  const model = String((agentRecord && agentRecord.model) || '');
  if (!model || CLIENT_ROUTE.test(model)) return { cap: own, estimated: false };
  try {
    const cb = require('./context-budget');
    const url = (k) => { try { return require('./settings').getProviderUrl(k); } catch { return null; } };
    const w = await cb.windowForAgent(agentRecord, model, { lmStudioUrl: url('lmstudio'), ninferUrl: url('ninfer') });
    return { cap: cb.plan(w.window, { recordsCapBytes: own }).recordsBytes, estimated: /^(lmstudio|ninfer)\//i.test(model) && w.source === 'table' };
  } catch { return { cap: own, estimated: true }; }
}

// A record may legitimately be a symlink (e.g. medical/patients/pat.md linked into a workspace). But an
// agent's own Bash can also plant a symlink in its records folder, and the hub reads and writes records
// here in its own process, following that link on the host. So a record's resolved real path is confined:
// it must stay within the hub home or the workspaces tree, and must not resolve to a secret or to hub
// state/code (tool-policy.isSensitiveRead). Links into medical/ legal/ users/ share/ keep working; a link
// to /etc, a home dotfile, the app's data/ or lib/ is refused.
const { resolveLanding, underAny, realRoot } = require('./path-confine');
// The roots a record may resolve into, scoped to the agent: its own granted roots (own workspace, owner tree,
// the team folders it is actually on, and for the lead the hub tree). So a member's agent cannot link a record
// to another tenant's workspace or to a patient/matter file it was never granted. If the agent cannot be
// looked up (a transient agents-file problem), we fail CLOSED to the agent's own workspace rather than to a
// broad scope — a record never silently gains cross-tenant reach.
function agentRecordRoots(agentName) {
  if (!agentName) return null;   // no identity at all (e.g. a direct targetAllowed test / owner tooling): broad fallback
  // The agent's workspace dir only — never its records subdir: the agent can replace records/ with a symlink,
  // and realpath'ing that root would make the symlink's target count as "inside". The workspace dir itself is
  // not agent-writable (its entry lives in the un-mounted parent), so it is a trustworthy root.
  const own = [path.join(HUB_ROOT, 'workspaces', String(agentName))];
  try {
    const agent = require('./agents').getAgentsSync().find(a => a.name === String(agentName));
    if (agent) return require('./tool-policy').policyFor(agent).roots.map(realRoot);
  } catch {}
  return own.map(realRoot);   // lookup failed: only the agent's own workspace (never cross-tenant)
}
let _broadRoots = null;
function broadRoots() {
  if (_broadRoots) return _broadRoots;
  let hubHome; try { hubHome = require('./hub-home').HUB_HOME; } catch {}
  _broadRoots = [hubHome, path.join(HUB_ROOT, 'workspaces')].filter(Boolean).map(realRoot);
  return _broadRoots;
}
/** targetAllowed(realPath, agentName) -> is a record's resolved real target safe for this agent to read/write? */
function targetAllowed(real, agentName) {
  let sensitive = false;
  try { sensitive = require('./tool-policy').isSensitiveRead(real); } catch {}
  if (sensitive) return false;
  const roots = agentRecordRoots(agentName) || broadRoots();
  return underAny(real, roots);
}
/** safeTarget(dir, name, agentName) -> { p, ok }. Resolves where the record really lands (following symlinks on
 *  every component — a not-yet-created name under its real parent, a dangling or nested link to its real
 *  target) and confines that to the agent's allowed roots. */
function safeTarget(dir, n, agentName) {
  const p = path.join(dir, n);
  return { p, ok: targetAllowed(resolveLanding(p), agentName) };
}

/** list(agent, { strict }) -> [{ name, bytes, mtime, symlink, target }]: the working brief first, then by name.
 *  strict: a folder or a file that exists but can't be read throws (naming the file) instead of being left out. */
function list(agentName, { strict = false } = {}) {
  const dir = folderFor(agentName);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { if (strict && e.code !== 'ENOENT') throw e; return []; }
  const out = [];
  for (const n of names) {
    if (n.startsWith('.') || !/\.(md|txt)$/i.test(n)) continue;
    if (cleanName(n) !== n) continue;   // read() could never open it: never listed or loaded (see unloadable)
    const p = path.join(dir, n);
    if (!safeTarget(dir, n, agentName).ok) continue;   // a symlink that escapes the records area is never listed or loaded
    try {
      const l = fs.lstatSync(p); const st = fs.statSync(p);
      if (!st.isFile()) continue;
      out.push({ name: n, bytes: st.size, mtime: st.mtime.toISOString(), symlink: l.isSymbolicLink(), target: l.isSymbolicLink() ? fs.readlinkSync(p) : null });
    } catch (e) { if (strict && e.code !== 'ENOENT') throw new Error(`${n}: ${e.code || e.message}`); }
  }
  const brief = (n) => n.toLowerCase() === BRIEF;
  return out.sort((a, b) => (brief(b.name) - brief(a.name)) || a.name.localeCompare(b.name));
}

function read(agentName, name) {
  const n = cleanName(name); if (!n) return null;
  const s = safeTarget(folderFor(agentName), n, agentName);
  if (!s.ok) return null;
  try { return fs.readFileSync(s.p, 'utf8'); } catch { return null; }
}

/** write(agent, name, content, { append }) -> status text. Writes go through the symlink to the real file. */
function write(agentName, name, content, { append = false } = {}) {
  const n = cleanName(name); if (!n) return 'Bad record name.';
  const dir = folderFor(agentName);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, n);
  if (!safeTarget(dir, n, agentName).ok) return `Record ${n} resolves outside your records area and was not written.`;
  const body = String(content ?? '');
  try {
    if (append) fs.appendFileSync(p, (fs.existsSync(p) && !body.startsWith('\n') ? '\n' : '') + body, 'utf8');
    else {
      // Atomic replace unless it is a symlink (then write the target in place so the link survives).
      let link = false; try { link = fs.lstatSync(p).isSymbolicLink(); } catch {}
      if (link) fs.writeFileSync(p, body, 'utf8');
      else { const tmp = `${p}.tmp-${process.pid}`; fs.writeFileSync(tmp, body, 'utf8'); fs.renameSync(tmp, p); }
    }
  } catch (e) { return `Could not write record ${n}: ${e.message}`; }
  const st = fs.statSync(p);
  let u = null; try { u = usage(agentName); } catch {}
  if (u && u.notLoaded.some(f => f.name === n)) return `Record ${n} ${append ? 'appended' : 'written'} (${st.size} bytes), but it doesn't fit in your Records cap, so it will NOT be loaded on your next turn. ${fullNote(u)}`;
  return `Record ${n} ${append ? 'appended' : 'written'} (${st.size} bytes). It is loaded in full on your next turn.${u && needsNote(u) ? ` ${fullNote(u)}` : ''}`;
}

/**
 * unloadable(agent) -> [{ name, kind, why }]: files in the records folder that look like Records but are never loaded,
 * and so never counted or mentioned anywhere else. kind 'link': a link to a file that no longer exists, one that goes
 * round in a circle, one the hub won't follow (outside the agent's allowed places, or a protected file); kind 'name':
 * a name read() can't open. lib/memory-health reports them.
 */
function unloadable(agentName) {
  const dir = folderFor(agentName);
  let names = []; try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (n.startsWith('.') || !/\.(md|txt)$/i.test(n)) continue;
    const p = path.join(dir, n);
    let l; try { l = fs.lstatSync(p); } catch { continue; }
    if (!l.isFile() && !l.isSymbolicLink()) continue;   // a folder named like a Record was never one
    if (cleanName(n) !== n) { out.push({ name: n, kind: 'name', why: 'its name has characters or a length the hub can\'t open' }); continue; }
    if (!l.isSymbolicLink()) continue;
    let st = null;
    try { st = fs.statSync(p); } catch (e) {
      out.push({ name: n, kind: 'link', why: e.code === 'ENOENT' ? 'a link to a file that no longer exists' : e.code === 'ELOOP' ? 'a link that goes round in a circle' : `a link the hub can't follow (${e.code || e.message})` });
      continue;
    }
    if (st.isFile() && !safeTarget(dir, n, agentName).ok) out.push({ name: n, kind: 'link', why: 'a link the hub won\'t follow' });
  }
  return out;
}

/**
 * loadPlan(agent, cap, { strict }) -> { loaded: [{ name, body }], skipped: [{ name, bytes }], used }: the files a prompt
 * loads under `cap` (in characters), in load order (the working brief first, then by name), and those it leaves out.
 * A file whose size alone shows it can't fit is left out unread (one character of text takes at most 3 bytes), so a
 * huge file is never read. contextSection, usage (the agent's replies) and lib/memory-health all count with this.
 * strict: a file that exists but can't be read throws, naming it.
 */
function loadPlan(agentName, cap, { strict = false } = {}) {
  const loaded = [], skipped = [];
  let used = 0;
  for (const i of list(agentName, { strict })) {
    if (used + Math.ceil(i.bytes / 3) > cap) { skipped.push({ name: i.name, bytes: i.bytes }); continue; }
    let body = null;
    if (strict) {
      const s = safeTarget(folderFor(agentName), i.name, agentName);
      try { body = s.ok ? fs.readFileSync(s.p, 'utf8') : null; } catch (e) { throw new Error(`${i.name}: ${e.code || e.message}`); }
    } else body = read(agentName, i.name);
    if (body == null) continue;
    if (used + body.length > cap) { skipped.push({ name: i.name, bytes: i.bytes }); continue; }
    used += body.length;
    loaded.push({ name: i.name, body });
  }
  return { loaded, skipped, used };
}

/**
 * usage(agent, { agentRecord, strict, cap }) -> { used, cap, pct, files, notLoaded: [{ name, bytes }] }: what the next
 * turn loads (loadPlan) under `cap`, else the cap the agent's route uses (loadCap). used counts the loaded text; pct is
 * of the cap, rounded.
 */
function usage(agentName, { agentRecord = null, strict = false, cap = null } = {}) {
  if (!agentRecord) { try { agentRecord = require('./agents').getAgentsSync().find(a => a.name === String(agentName)) || null; } catch {} }
  const c = Number(cap) > 0 ? Number(cap) : loadCap(agentName, { agentRecord });
  const p = loadPlan(agentName, c, { strict });
  return { used: p.used, cap: c, pct: c ? Math.round((p.used / c) * 100) : 0, files: p.loaded.length, notLoaded: p.skipped };
}
const kb = (n) => `${Math.round(n / 1024)} KB`;
const needsNote = (u) => u.notLoaded.length > 0 || u.pct >= WARN_AT * 100;
function fullNote(u) {
  const lost = u.notLoaded.length ? ` Not loaded now: ${u.notLoaded.map(f => `${f.name} (${kb(f.bytes)})`).join(', ')}.` : '';
  return `Your Records use ${kb(u.used)} of their ${kb(u.cap)} cap (${u.pct}%); a file that would pass the cap is not loaded.${lost} Condense them soon: keep every fact you still need, and remove what is out of date, repeated, or easy to find again with recall.`;
}

function remove(agentName, name) {
  const n = cleanName(name); if (!n) return false;
  const dir = folderFor(agentName);
  // Removing a record removes the directory ENTRY (the link itself, never its target), so authorise the
  // records FOLDER — not the followed target — so a symlinked records/ folder cannot unlink a host file, while
  // an escaping link inside the agent's own records folder can still be cleaned up.
  if (!targetAllowed(resolveLanding(dir), agentName)) return false;
  try { fs.unlinkSync(path.join(dir, n)); return true; } catch { return false; }
}

/** describe(agent) -> text for the record_list tool */
function describe(agentName) {
  const items = list(agentName);
  if (!items.length) return `You have no Records yet. Folder: ${folderFor(agentName)}. Create one with record_write.`;
  const tz = require('./timezone'); const zone = tz.zoneForAgent(agentName);   // the local time of the person it works for
  let u = null; try { u = usage(agentName); } catch {}
  return [`Records (loaded in full every turn), folder ${folderFor(agentName)}:`, ...items.map(i => `- ${i.name}: ${i.bytes} bytes, updated ${tz.stamp(i.mtime, zone)}${i.symlink ? ` (link to ${i.target})` : ''}`),
    ...(u ? [needsNote(u) ? fullNote(u) : `In all ${kb(u.used)} of their ${kb(u.cap)} cap (${u.pct}%).`] : [])].join('\n');
}

/**
 * contextSection(agent, { agentRecord, filesIndex }) -> markdown for the agent's context, or '' when there
 * are no records. Every record in full, oldest-named first, until the byte cap; files beyond it are named.
 */
function contextSection(agentName, { agentRecord = null, filesIndex = null } = {}) {
  const cap = maxBytesFor(agentName, { agentRecord });   // the caller passes the route's cap (lib/agents.js)
  capSeen.set(String(agentName), { cap, model: String((agentRecord && agentRecord.model) || '') });
  const plan = loadPlan(agentName, cap);
  const parts = plan.loaded.map(f => `### ${f.name}\n${f.body.trim()}`);
  const skipped = plan.skipped.map(f => `${f.name} (${f.bytes} bytes)`);
  const used = plan.used;
  if (!parts.length && !skipped.length && !filesIndex) return '';
  const head = `# Records (source of truth, loaded in full every turn)\nThese are your own documents, kept current by you with record_write. Treat them as the facts of record. Anything older that is NOT here can be found with recall (your full transcript archive); say plainly when something is in neither. Do not answer from assumption.`;
  const pct = cap ? Math.round((used / cap) * 100) : 0;
  const tail = skipped.length ? `\n\n(Not loaded, over the ${Math.round(cap / 1024)} KB records cap: ${skipped.join(', ')}. Condense your Records: keep every fact you still need, and remove what is out of date, repeated, or easy to find again with recall.)`
    : pct >= WARN_AT * 100 ? `\n\n(Your Records use ${kb(used)} of their ${kb(cap)} cap (${pct}%); past it, files stop loading. Condense them soon: keep every fact you still need, and remove what is out of date, repeated, or easy to find again with recall.)` : '';
  const files = filesIndex ? `\n\n### Files folder index (maintained by the hub)\n${filesIndex}` : '';
  return `${head}\n\n${parts.join('\n\n')}${tail}${files}`;
}

/** filesIndex(dir, { max, zone }) -> one line per file under the agent's Files folder (recursive, newest first), each
 *  dated in `zone` (the local time of the person the agent works for; lib/timezone). */
function filesIndex(dir, { max = 200, zone = 'UTC' } = {}) {
  const rows = [];
  const walk = (d, rel) => {
    let names = []; try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      if (n.startsWith('.')) continue;
      const p = path.join(d, n);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, rel ? `${rel}/${n}` : n);
      else rows.push({ rel: rel ? `${rel}/${n}` : n, bytes: st.size, mtime: st.mtime });
    }
  };
  walk(dir, '');
  rows.sort((a, b) => b.mtime - a.mtime);
  const localDate = require('./timezone').localDate;
  const shown = rows.slice(0, max).map(r => `- ${r.rel} (${r.bytes} bytes, ${localDate(zone, r.mtime.getTime())})`);
  if (!rows.length) return `(empty) ${dir}`;
  return `${dir}\n${shown.join('\n')}${rows.length > max ? `\n… and ${rows.length - max} more` : ''}`;
}

module.exports = { folderFor, list, read, write, remove, describe, contextSection, filesIndex, maxBytesFor, loadCap, routeCap, loadPlan, unloadable, cleanName, targetAllowed, usage, DEFAULT_MAX, WARN_AT, BRIEF };
