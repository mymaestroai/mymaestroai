'use strict';
// Records: per-agent documents the hub loads IN FULL into the agent's context on every turn. They are
// the agent's source of truth (a patient summary, a matter file, a job file, open positions, standing
// rules), never searched for relevance, never trimmed, never summarised by a provider. The agent keeps
// them current with record_write; the owner can read and edit them on the agent's settings page.
//
// Folder: workspaces/<agent>/records/*.md (symlinks allowed, so a file that already lives elsewhere, like
// medical/patients/pat.md, can be a record without moving). Size cap per agent: agents.json
// `recordsMaxBytes`, else settings.recordsMaxBytes, else 256 KB; past the cap the newest files are
// dropped from the load and the agent is told which ones.

const fs = require('fs');
const path = require('path');

const HUB_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MAX = 256 * 1024;

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

/** list(agent) -> [{ name, bytes, mtime, symlink, target }] sorted by name */
function list(agentName) {
  const dir = folderFor(agentName);
  let names = []; try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (n.startsWith('.') || !/\.(md|txt)$/i.test(n)) continue;
    const p = path.join(dir, n);
    if (!safeTarget(dir, n, agentName).ok) continue;   // a symlink that escapes the records area is never listed or loaded
    try {
      const l = fs.lstatSync(p); const st = fs.statSync(p);
      if (!st.isFile()) continue;
      out.push({ name: n, bytes: st.size, mtime: st.mtime.toISOString(), symlink: l.isSymbolicLink(), target: l.isSymbolicLink() ? fs.readlinkSync(p) : null });
    } catch {}
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
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
  return `Record ${n} ${append ? 'appended' : 'written'} (${st.size} bytes). It is loaded in full on your next turn.`;
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
  return [`Records (loaded in full every turn), folder ${folderFor(agentName)}:`, ...items.map(i => `- ${i.name}: ${i.bytes} bytes, updated ${tz.stamp(i.mtime, zone)}${i.symlink ? ` (link to ${i.target})` : ''}`)].join('\n');
}

/**
 * contextSection(agent, { agentRecord, filesIndex }) -> markdown for the agent's context, or '' when there
 * are no records. Every record in full, oldest-named first, until the byte cap; files beyond it are named.
 */
function contextSection(agentName, { agentRecord = null, filesIndex = null } = {}) {
  const items = list(agentName);
  const cap = maxBytesFor(agentName, { agentRecord });
  const parts = []; const skipped = [];
  let used = 0;
  for (const i of items) {
    const body = read(agentName, i.name);
    if (body == null) continue;
    if (used + body.length > cap) { skipped.push(`${i.name} (${i.bytes} bytes)`); continue; }
    used += body.length;
    parts.push(`### ${i.name}\n${body.trim()}`);
  }
  if (!parts.length && !skipped.length && !filesIndex) return '';
  const head = `# Records (source of truth, loaded in full every turn)\nThese are your own documents, kept current by you with record_write. Treat them as the facts of record. Anything older that is NOT here can be found with recall (your full transcript archive); say plainly when something is in neither. Do not answer from assumption.`;
  const tail = skipped.length ? `\n\n(Not loaded, over the ${Math.round(cap / 1024)} KB records cap: ${skipped.join(', ')}. Trim or split them.)` : '';
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

module.exports = { folderFor, list, read, write, remove, describe, contextSection, filesIndex, maxBytesFor, cleanName, targetAllowed, DEFAULT_MAX };
