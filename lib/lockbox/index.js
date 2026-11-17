'use strict';
// The command lockbox, hub side: decides whether a shell command runs boxed (Landlock + seccomp, through the
// Python helper lockbox-run.py next to this file), builds the box's profile, and wraps the command line.
// Modes: off (today's behaviour), watch (box it, log what the box would have refused), enforce (box it, refuse).
// Everything with a side effect takes its dependency through an options object and defaults to the real thing.

const path = require('path');
const os = require('os');
const fsReal = require('fs');
const crypto = require('crypto');
const nodeChild = require('child_process');
const toolPolicy = require('../tool-policy');

const MODES = ['off', 'watch', 'enforce'];
const AGENT_VALUES = ['inherit', ...MODES];
const PYTHON = '/usr/bin/python3';
const HELPER = path.join(__dirname, 'lockbox-run.py');
const DEV_WRITES = ['/dev/null', '/dev/zero', '/dev/full', '/dev/tty', '/dev/ptmx', '/dev/pts', '/dev/shm'];
const ENV_KEEP = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_*', 'TERM', 'TZ', 'COLUMNS', 'LINES'];
const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const PROBE_TTL = 10 * 60 * 1000;
const APPROVAL_TTL = 15 * 60 * 1000;
const WARN_EVERY = 10 * 60 * 1000;
const LOG_READ_MAX = 1024 * 1024;
const LOG_ROTATE = 5 * 1024 * 1024;   // watch.jsonl moves to watch.jsonl.1 past this size

function isUnder(p, root) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
const uniqSorted = (list) => [...new Set(list.map(p => path.resolve(p)))].sort();
function clock(now) {
  if (typeof now === 'function') return Number(now());
  if (now instanceof Date) return now.getTime();
  return Number.isFinite(now) ? now : Date.now();
}
function validMode(v) { return MODES.includes(v) ? v : null; }

/** The agent's own setting, else the hub default, else off. Unknown values count as unset. */
function resolveMode(agent, { getSetting = () => undefined } = {}) {
  return validMode(agent && agent.lockbox) || validMode(getSetting('lockboxDefault')) || 'off';
}

// ── Host check ───────────────────────────────────────────────────────
let probeCache = null;   // { at, result }
let warned = new Map();  // agent -> time of the last 'watch-unavailable' line
function _resetProbe() { probeCache = null; warned = new Map(); }

/** What this computer can do: { ok, reason, ... } from the helper's --probe. Cached for 10 minutes. */
function probe({ execFileSync = nodeChild.execFileSync, platform = process.platform, now } = {}) {
  if (platform !== 'linux') return { ok: false, reason: 'not available on this computer' };
  const t = clock(now);
  if (probeCache && t >= probeCache.at && t - probeCache.at < PROBE_TTL) return probeCache.result;
  let result;
  try {
    const out = execFileSync(PYTHON, ['-I', '-S', HELPER, '--probe'], { timeout: 5000, encoding: 'utf8' });
    result = JSON.parse(String(out).trim().split('\n').filter(Boolean).pop() || '');
    if (!result || typeof result !== 'object') throw new Error('no answer');
  } catch (e) {
    result = { ok: false, reason: 'the lockbox helper could not run: ' + (e && e.message ? e.message : String(e)) };
  }
  probeCache = { at: t, result };
  return result;
}

// ── The agent's own folders ──────────────────────────────────────────
function agentDirs(name, { hubHome = toolPolicy.HUB_HOME } = {}) {
  const dir = path.join(hubHome, 'lockbox', name);
  return { dir, tmp: path.join(dir, 'tmp'), npm: path.join(dir, 'npm') };
}

/** Make <hubHome>/lockbox/<name>/{tmp,npm} (0700). A link or a non-folder anywhere on the way is refused. */
function prepareAgentDirs(name, { hubHome = toolPolicy.HUB_HOME, fs = fsReal } = {}) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('"' + String(name).slice(0, 80) + '" is not a valid agent name');
  const dirs = agentDirs(name, { hubHome });
  for (const d of [path.join(hubHome, 'lockbox'), dirs.dir, dirs.tmp, dirs.npm]) {
    let st = null;
    try { st = fs.lstatSync(d); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
    if (st) {
      if (st.isSymbolicLink()) throw new Error(d + ' is a link');
      if (!st.isDirectory()) throw new Error(d + ' is not a folder');
    } else {
      fs.mkdirSync(d, { mode: 0o700 });
    }
    fs.chmodSync(d, 0o700);
  }
  return dirs;
}

// ── The profile ──────────────────────────────────────────────────────
/** Holes apply to every role but the lead, unless the agent's own rules let it act on admin things. */
function rolesWithHoles(policy) {
  if (!policy || policy.role === 'lead') return false;
  return !(policy.rules && policy.rules.admin === 'allow');
}

/**
 * Read holes inside the install: every entry of data/ but jobs/ (the hub keeps secrets there under many names, so the
 * box hides the whole folder rather than guess by name; job folders stay readable because a job's own script runs from
 * there), a marker that keeps entries made later in data/ hidden too, and the install's .env files. If data/ can't be
 * listed, all of it is the hole.
 */
function installHoles(hubRoot, fs) {
  const data = path.join(hubRoot, 'data');
  const out = [path.join(data, '.lockbox-hidden')];
  let entries = null;
  try { entries = fs.readdirSync(data); } catch (e) { if (!e || e.code !== 'ENOENT') out.push(data); }
  if (entries) for (const n of entries) if (n !== 'jobs') out.push(path.join(data, n));
  try { for (const n of fs.readdirSync(hubRoot)) if (/^\.env/.test(n)) out.push(path.join(hubRoot, n)); } catch { /* none */ }
  return out;
}

/**
 * A write root the agent itself could have bent is not granted: a link at the root, or a link at any folder on the
 * way that lies inside one of the agent's own write roots (made while its commands ran unconfined, or by another of its
 * boxed commands). Links above that, which only an administrator makes (/home pointing elsewhere), are followed.
 * Returns the real path, null when the root is missing (nothing to grant), or false when a link bends it.
 */
function safeRoot(root, roots, fs) {
  let cur = '/';
  for (const part of root.split('/').filter(Boolean)) {
    cur = path.join(cur, part);
    let st;
    try { st = fs.lstatSync(cur); } catch { return null; }
    if (st.isSymbolicLink() && (cur === root || roots.some(r => isUnder(cur, r)))) return false;
  }
  try { return fs.realpathSync(root); } catch { return null; }
}

function listWorkspaces(hubRoot, fs) {
  try { return fs.readdirSync(path.join(hubRoot, 'workspaces')); } catch { return []; }
}

function labelOf(command) { return String(command == null ? '' : command).replace(/\s+/g, ' ').slice(0, 300); }

function buildProfile({ agent, policy, mode, tool, command, cwdFile = null, widen = { writes: [], reads: [] },
  hubHome = toolPolicy.HUB_HOME, hubRoot = toolPolicy.HUB_ROOT, home = os.homedir(), workspaces, fs = fsReal } = {}) {
  void home;
  if (!agent || typeof agent.name !== 'string' || !NAME_RE.test(agent.name)) throw new Error('"' + String(agent && agent.name).slice(0, 80) + '" is not a valid agent name');
  const dirs = agentDirs(agent.name, { hubHome });
  const lockboxDir = path.resolve(hubHome, 'lockbox');
  const wideW = ((widen && widen.writes) || []).map(p => path.resolve(p));
  const wideR = ((widen && widen.reads) || []).map(p => path.resolve(p));
  const lead = policy.role === 'lead';
  let writes, writeHoles = [], readHoles = [], env = null;
  const skipped = [];   // write roots not granted because a link bends them

  if (lead) {
    // The lead is trusted: its roots (the hub home, /tmp and any folders granted to it) are taken as they resolve.
    writes = uniqSorted([hubHome, '/tmp', os.tmpdir(), ...policy.roots, ...wideW].map(r => { try { return fs.realpathSync(r); } catch { return path.resolve(r); } }));
  } else {
    const names = Array.isArray(workspaces) ? workspaces : listWorkspaces(hubRoot, fs);
    writeHoles = uniqSorted([...toolPolicy.adminWriteRoots(),
      ...names.filter(n => typeof n === 'string' && n && n !== agent.name && !n.includes('/') && n !== '.' && n !== '..').map(n => path.join(hubRoot, 'workspaces', n)),
      lockboxDir]);
    if (rolesWithHoles(policy)) {
      const approved = new Set(wideR);
      readHoles = uniqSorted([...toolPolicy.SENSITIVE_READ, ...installHoles(hubRoot, fs), lockboxDir]).filter(p => !approved.has(p));
    }
    const roots = policy.roots.map(r => path.resolve(r));
    for (const r of [...roots, ...wideW]) {
      if (r !== dirs.dir && isUnder(lockboxDir, r)) throw new Error(r + ' would cover other agents\' lockbox folders');
    }
    const holes = [...writeHoles, ...readHoles];
    const kept = roots.filter(r => !holes.some(h => isUnder(r, h)));
    const mine = [...roots, dirs.dir];
    writes = [];
    for (const r of uniqSorted([...kept, dirs.dir, ...wideW])) { const real = safeRoot(r, mine, fs); if (real) writes.push(real); else if (real === false) skipped.push(r); }
    writes = uniqSorted(writes);
    const names2 = Array.isArray(agent.lockboxEnv) ? agent.lockboxEnv.filter(n => typeof n === 'string' && ENV_NAME_RE.test(n)).slice(0, 32) : [];
    env = { keep: [...new Set([...ENV_KEEP, ...names2])], set: { TMPDIR: dirs.tmp, npm_config_cache: dirs.npm } };
  }
  return {
    v: 1, mode, agent: agent.name, tool, writes, writeHoles, readHoles, devWrites: DEV_WRITES.slice(), env, skipped,
    cwdFile, blockUnixSockets: true, blockIoUring: true,
    log: { path: path.join(hubRoot, 'data', 'lockbox', 'watch.jsonl'), max: 50 },
    label: labelOf(command),
  };
}

// ── Approvals that widen one command's box ───────────────────────────
const approvals = new Map();   // agent \0 sha256(command) -> { writes, reads, expires }
const approvalKey = (agent, command) => agent + '\0' + crypto.createHash('sha256').update(String(command)).digest('hex');
const absOnly = (list) => (Array.isArray(list) ? list : []).filter(p => typeof p === 'string' && path.isAbsolute(p)).map(p => path.resolve(p)).slice(0, 50);

function noteApproval({ agent, command, writes = [], reads = [], now } = {}) {
  const key = approvalKey(agent, command);
  approvals.delete(key);
  approvals.set(key, { writes: absOnly(writes), reads: absOnly(reads), expires: clock(now) + APPROVAL_TTL });
  while (approvals.size > 500) approvals.delete(approvals.keys().next().value);
}

function takeApproval(agent, command, { now } = {}) {
  const key = approvalKey(agent, command);
  const a = approvals.get(key);
  if (!a) return { writes: [], reads: [] };
  approvals.delete(key);
  if (clock(now) >= a.expires) return { writes: [], reads: [] };
  return { writes: a.writes, reads: a.reads };
}
function _resetApprovals() { approvals.clear(); }

// ── The log ──────────────────────────────────────────────────────────
function logFile(hubRoot) { return path.join(hubRoot, 'data', 'lockbox', 'watch.jsonl'); }

function appendLog(entry, { hubRoot = toolPolicy.HUB_ROOT, fs = fsReal } = {}) {
  const file = logFile(hubRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { if (fs.statSync(file).size > LOG_ROTATE) fs.renameSync(file, file + '.1'); } catch { /* no log yet */ }
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

function readLog({ agent, limit = 100, hubRoot = toolPolicy.HUB_ROOT, fs = fsReal } = {}) {
  const max = Math.max(0, Math.min(500, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 100));
  let text;
  try {
    const fd = fs.openSync(logFile(hubRoot), 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - LOG_READ_MAX);
      const buf = Buffer.alloc(size - start);
      let got = 0;
      while (got < buf.length) { const n = fs.readSync(fd, buf, got, buf.length - got, start + got); if (!n) break; got += n; }
      text = buf.subarray(0, got).toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);   // the first line is cut off
    } finally { fs.closeSync(fd); }
  } catch { return []; }
  const out = [];
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
    if (!lines[i].trim()) continue;
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    if (agent && e.agent !== agent) continue;
    out.push(e);
  }
  return out;
}

// ── The decision ─────────────────────────────────────────────────────
function decide({ agent, tool, command, getSetting = () => undefined, sandboxed = false, sudo = false, platform = process.platform,
  probe: probeFn, hubHome = toolPolicy.HUB_HOME, hubRoot = toolPolicy.HUB_ROOT, home = os.homedir(), workspaces, now, fs = fsReal, policy } = {}) {
  const mode = resolveMode(agent, { getSetting });
  if (mode === 'off' || sandboxed) return { mode: 'off' };
  const t = clock(now);
  const label = labelOf(command);
  const log = (rule, p) => { try { appendLog({ ts: new Date(t).toISOString(), agent: agent.name, tool, mode, cmd: label, op: 'run', path: p, rule }, { hubRoot, fs }); } catch { /* a log that cannot be written never stops a command */ } };
  const warn = (reason) => {
    const last = warned.get(agent.name);
    if (last !== undefined && t >= last && t - last < WARN_EVERY) return;
    warned.set(agent.name, t);
    log('watch-unavailable', reason);
  };
  const pol = policy || toolPolicy.policyFor(agent);
  if (pol.role === 'lead' && sudo) { log('sudo-unconfined', ''); return { mode, unconfined: 'sudo' }; }

  const host = (probeFn || (() => probe({ platform, now: t })))();
  if (!host || !host.ok) {
    const reason = (host && host.reason) || 'unknown reason';
    if (mode === 'enforce') return { mode, refuse: 'The command lockbox is set to enforce for this agent, but it cannot run on this computer (' + reason + '), so the command was not run.' };
    warn(reason);
    return { mode, plain: true };
  }
  try {
    prepareAgentDirs(agent.name, { hubHome, fs });
    const widen = takeApproval(agent.name, command, { now: t });
    const profile = buildProfile({ agent, policy: pol, mode, tool, command, widen, hubHome, hubRoot, home, workspaces, fs });
    for (const r of profile.skipped) log('root-is-link', r);   // a bent root is never granted; say so once per command
    return { mode, profile };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (mode === 'enforce') return { mode, refuse: 'The command lockbox could not prepare this agent\'s box (' + msg + '), so the command was not run.' };
    warn(msg);
    return { mode, plain: true };
  }
}

// ── Wrapping the command ─────────────────────────────────────────────
function shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
const b64 = (profile) => Buffer.from(JSON.stringify(profile), 'utf8').toString('base64');

function argvFor(profile, argv) {
  return { file: PYTHON, args: ['-I', '-S', HELPER, '--profile-b64', b64(profile), '--', ...argv] };
}

/** The shell line a run_job script uses; $D is the job folder, expanded by the shell. */
function jobLine(profile) {
  return shQuote(PYTHON) + ' -I -S ' + shQuote(HELPER) + ' --profile-b64 ' + shQuote(b64(profile)) + ' -- bash "$D/job.sh"';
}

/** For a Claude client's Bash tool: run `command` boxed and carry its final folder over to the next call. */
function clientCommand(profile, command, { randomBytes = crypto.randomBytes } = {}) {
  // In the agent's own folder (only its own box can write there; the name is visible in the helper's command line),
  // or /tmp for the lead, whose box has no own folder in its environment.
  const dir = profile && profile.env && profile.env.set && profile.env.set.TMPDIR ? profile.env.set.TMPDIR : '/tmp';
  const cwdFile = path.join(dir, 'lockbox-cwd-' + randomBytes(12).toString('hex'));
  const boxed = { ...profile, cwdFile };
  const inner = String(command) + '\n' + '__lb_rc=$?; pwd -P > "$LOCKBOX_CWD_FILE" 2>/dev/null; exit $__lb_rc';
  return shQuote(PYTHON) + ' -I -S ' + shQuote(HELPER) + ' --profile-b64 ' + shQuote(b64(boxed)) + ' -- bash -c ' + shQuote(inner) + '\n'
    + '__lb_rc=$?; __lb_d=$(cat ' + shQuote(cwdFile) + ' 2>/dev/null); rm -f ' + shQuote(cwdFile)
    + '; if [ -n "$__lb_d" ]; then cd "$__lb_d" 2>/dev/null; fi; (exit $__lb_rc)';
}

// ── Status for the settings page ─────────────────────────────────────
function statusFor({ agents = [], getSetting = () => undefined, probe: probeFn, sandboxedOf = () => false, handsOf = () => 'hub' } = {}) {
  const host = typeof probeFn === 'function' ? probeFn() : (probeFn || probe());
  return {
    host,
    default: validMode(getSetting('lockboxDefault')) || 'off',
    agents: agents.map(agent => {
      let coverage = 'covered';
      if (sandboxedOf(agent)) coverage = 'container';
      else if (typeof agent.model === 'string' && agent.model.startsWith('codex-cli/') && handsOf(agent) === 'client') coverage = 'codex-client';
      else if (!host || !host.ok) coverage = 'unavailable';
      return { name: agent.name, setting: AGENT_VALUES.includes(agent.lockbox) ? agent.lockbox : 'inherit', mode: resolveMode(agent, { getSetting }), coverage };
    }),
  };
}

module.exports = {
  MODES, AGENT_VALUES, PYTHON, HELPER, DEV_WRITES, ENV_KEEP, NAME_RE, ENV_NAME_RE,
  resolveMode, probe, _resetProbe, _resetApprovals, agentDirs, prepareAgentDirs, rolesWithHoles, buildProfile, decide,
  noteApproval, takeApproval, argvFor, jobLine, clientCommand, shQuote, appendLog, readLog, statusFor,
};
