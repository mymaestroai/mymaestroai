'use strict';
// restart.js — one way to restart the hub from inside it (the UI button, the RestartHub tool), whatever supervises it.
//
//   systemd (Linux service, user or system scope): the process asks itself to exit with code 75 after a short delay
//     (SIGUSR2 -> graceful shutdown -> exit 75). systemd restarts the unit on the new code whether it has
//     Restart=always or Restart=on-failure, since 75 is a failure code. (A tester found the old script path
//     never worked on systemd installs: safe-restart.sh appended to a root-owned server.log and died silently.)
//   launchd (macOS service installed by setup): launchctl kickstart -k restarts the job on the new code.
//
// A hub restarts only ITSELF. Which service runs this process is proven, never assumed: a candidate launchd label (this
// folder's own from data/install.json or ~/Library/LaunchAgents, XPC_SERVICE_NAME, the legacy com.agent-hub, the
// installer's ai.mymaestro.hub) counts only when `launchctl print` says that job's pid is this process; a systemd unit
// only when its MainPID is (in either scope: a user unit may share a system unit's name). A service that starts node
// through a shell or npm (ExecStart=bash -lc '… node server.js' for nvm, npm start) reports the wrapper: it counts
// when the wrapper is this process's parent and was itself started by the service manager. Labels and environment
// variables alone prove nothing: two hubs on one Mac may share a legacy label, and a hub started from an agent's shell
// inherits XPC_SERVICE_NAME / INVOCATION_ID from the hub that runs the agent, and sits in that hub's cgroup (a test
// hub's Restart once kickstarted the live hub this way). When systemd can't be asked (no bus), the unit in this
// process's cgroup counts only if systemd itself started this process. When this folder's own service is running
// another process, the restart is refused with the reason rather than restarting something else.
//   nothing (started by hand, nohup, or an old restart): scripts/relaunch.js runs detached with the hub's own node
//     binary, environment and arguments; it waits for this process to exit (we signal ourselves), waits for the port,
//     starts the new server and checks /api/health. Its output goes to data/restart.log. (An unsupervised Mac install: the
//     old bash chain failed without a trace and the button reported success because the old server still answered.)
//
// The page proves a restart by comparing the boot id from /api/health before and after; a restart that leaves the
// same process running is reported as a failure with the log, never as success.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const EXIT_RESTART = 75;   // EX_TEMPFAIL: "try again later" — systemd's on-failure restarts on it
const SYSTEMD_DELAY_MS = 1500;
const LAUNCHD_LABEL = 'com.agent-hub';            // the label of hubs set up before the installer (setup.sh)
const HUB_DIR = path.join(__dirname, '..');
const SUPERVISOR_TTL_MS = 30000;

/** True when systemd's variables are present. Inherited by anything the hub starts, so a hint only: see supervisor(). */
function underSystemd(env = process.env) { return !!(env.INVOCATION_ID || env.JOURNAL_STREAM || env.NOTIFY_SOCKET); }

const LABEL_RE = /^[A-Za-z][\w.-]{0,200}$/;
const run = (execImpl, cmd, args) => String(execImpl(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }) || '');

/** The pid launchd reports for a job in this user's GUI domain: a number, null when loaded but not running, undefined when not loaded. */
function launchdJobPid(label, { uid, execImpl }) {
  let out;
  try { out = run(execImpl, 'launchctl', ['print', `gui/${uid}/${label}`]); } catch { return undefined; }
  const m = out.match(/^\tpid = (\d+)\s*$/m) || out.match(/^\s*pid = (\d+)\s*$/m);
  return m ? Number(m[1]) : null;
}

/** The MainPID systemd reports for a unit in one scope ('user' | 'system'): a number (0 = not running), null when that
 *  scope can't be asked (no bus, no systemctl). */
function systemdMainPid(unit, scope, { execImpl }) {
  try {
    const m = run(execImpl, 'systemctl', [...(scope === 'user' ? ['--user'] : []), 'show', '-p', 'MainPID', unit]).trim().match(/^(?:MainPID=)?(\d+)$/);   // no --value: systemd before 230 lacks it
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

/** A process's parent pid, name and arguments: /proc on Linux, ps elsewhere; null when unreadable. */
function procInfo(pid, { platform, fsImpl, execImpl }) {
  if (!(pid > 0)) return null;
  if (platform === 'linux') {
    try {
      const ppid = Number((fsImpl.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^PPid:\s*(\d+)/m) || [])[1]);
      if (!(ppid >= 0)) return null;
      const comm = String(fsImpl.readFileSync(`/proc/${pid}/comm`, 'utf8')).trim();
      let argv = [];
      try { argv = String(fsImpl.readFileSync(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean); } catch { /* unreadable */ }
      return { ppid, comm, argv };
    } catch { return null; }
  }
  try {
    const m = run(execImpl, 'ps', ['-o', 'ppid=,comm=', '-p', String(pid)]).trim().match(/^(\d+)\s+(.+)$/);
    if (!m) return null;
    let args = '';
    try { args = run(execImpl, 'ps', ['-o', 'args=', '-p', String(pid)]).trim(); } catch { /* unreadable */ }
    return { ppid: Number(m[1]), comm: path.basename(m[2]), argv: args.split(/\s+/) };
  } catch { return null; }
}
/** A shell or npm: how a service runs node through nvm (bash -lc '… node server.js') or npm start. */
function isWrapper(info) {
  return !!info && (/^(sh|bash|dash|zsh|ksh|npm( .*)?)$/.test(info.comm) || (info.comm === 'node' && /(^|\/)(npm|npm-cli\.js)$/.test(info.argv[1] || '')));
}
/** The service manager: pid 1 (launchd, systemd) or a systemd --user instance. */
function isManager(pid, opts) { if (pid === 1) return true; const i = procInfo(pid, opts); return !!i && i.comm === 'systemd'; }
/** The process a service manager reports runs THIS process: it is this process, or this process's parent is a wrapper
 *  the manager started. */
function runsUs(reported, pid, opts) {
  if (!(reported > 0)) return false;
  if (reported === pid) return true;
  const me = procInfo(pid, opts);
  if (!me || me.ppid !== reported) return false;
  const parent = procInfo(reported, opts);
  return isWrapper(parent) && isManager(parent.ppid, opts);
}
/** Started by the service manager itself, directly or through a wrapper it started: true, false, or null when this
 *  process can't be looked at. For when the manager can't be asked. */
function startedByManager(pid, opts) {
  const me = procInfo(pid, opts);
  if (!me) return null;
  if (isManager(me.ppid, opts)) return true;
  const parent = procInfo(me.ppid, opts);
  return isWrapper(parent) && isManager(parent.ppid, opts);
}

/** This folder's own service as recorded or installed (lib/service-manager detect): { kind, label?, unit? }. */
function folderService(projectDir, platform) {
  try { return require('./service-manager').createServiceManager({ dir: projectDir, platform }).detect(); } catch { return { kind: 'none' }; }
}

const cache = new Map();
/**
 * Which supervisor runs THIS process: { kind: 'launchd', label } | { kind: 'systemd', unit } | { kind: 'none' } |
 * { kind: 'unknown', reason }. Test hooks: env, platform, pid, uid, execImpl, fsImpl, folder (this folder's service).
 */
function supervisor({ projectDir = HUB_DIR, env = process.env, platform = process.platform, pid = process.pid, uid = (os.userInfo && os.userInfo().uid), execImpl = execFileSync, fsImpl = fs, folder = null, fresh = false } = {}) {
  const useCache = execImpl === execFileSync && !folder;
  const key = `${projectDir}|${pid}`;
  const hit = useCache && !fresh && cache.get(key);
  if (hit && Date.now() - hit.at < SUPERVISOR_TTL_MS) return hit.value;
  const own = folder || folderService(projectDir, platform);
  const procOpts = { platform, fsImpl, execImpl };
  let value = { kind: 'none' };
  if (platform === 'darwin') {
    const xpc = String(env.XPC_SERVICE_NAME || '');
    const mine = own.kind === 'launchd' && own.label ? own.label : null;
    const candidates = [...new Set([mine, LABEL_RE.test(xpc) && !/^application\./.test(xpc) ? xpc : null, LAUNCHD_LABEL, 'ai.mymaestro.hub'].filter(Boolean))];
    let mineRunsOther = null;
    for (const label of candidates) {
      const p = launchdJobPid(label, { uid, execImpl });
      if (typeof p === 'number' && runsUs(p, pid, procOpts)) { value = { kind: 'launchd', label }; break; }
      if (label === mine && typeof p === 'number') mineRunsOther = p;
    }
    if (value.kind === 'none' && mineRunsOther) value = { kind: 'unknown', reason: `this folder's launchd service ${mine} is running another process (pid ${mineRunsOther}), not this one (pid ${pid}); restart it with "mymaestro restart"` };
  } else if (platform === 'linux') {
    let cg = null;
    try { cg = String(fsImpl.readFileSync(`/proc/${pid}/cgroup`, 'utf8')); } catch { /* no /proc */ }
    const fromCgroup = cg ? ((cg.match(/[\w@.:-]+\.service/g) || []).filter(u => !/^user@\d+\.service$/.test(u)).pop() || null) : null;
    const cgScope = cg && /\/user@\d+\.service\//.test(cg) ? 'user' : 'system';
    const mine = own.kind === 'systemd' && own.unit ? own.unit : null;   // a user unit (data/install.json or ~/.config/systemd/user)
    let askedCgroupUnit = false; let mineRunsOther = null;
    outer:
    for (const unit of [...new Set([fromCgroup, mine].filter(Boolean))]) {
      const scopes = unit === fromCgroup ? [cgScope, cgScope === 'user' ? 'system' : 'user'] : ['user', 'system'];
      for (const scope of scopes) {
        const p = systemdMainPid(unit, scope, { execImpl });
        if (p === null) continue;   // this scope can't be asked
        if (unit === fromCgroup) askedCgroupUnit = true;
        if (runsUs(p, pid, procOpts)) { value = { kind: 'systemd', unit, scope }; break outer; }
        if (unit === mine && scope === 'user' && p > 0) mineRunsOther = p;
      }
    }
    if (value.kind === 'none') {
      if (mineRunsOther) value = { kind: 'unknown', reason: `this folder's systemd unit ${mine} is running another process (pid ${mineRunsOther}), not this one (pid ${pid}); restart it with "mymaestro restart"` };
      else if (fromCgroup && !askedCgroupUnit) {
        // systemd can't be asked (no bus): its unit's own process is one systemd started; a hub started from an agent's
        // shell inside that unit has the shell as its parent and relaunches itself instead.
        const started = startedByManager(pid, procOpts);
        if (started) value = { kind: 'systemd', unit: fromCgroup, scope: cgScope };
        else if (started === null) value = { kind: 'unknown', reason: `this process (pid ${pid}) is in systemd unit ${fromCgroup}, which can't be asked whether it runs this process; restart it with "mymaestro restart" or systemctl` };
      }
      // systemd's variables but not even this process's cgroup to go by: the restart would be a guess.
      else if (!cg && underSystemd(env)) value = { kind: 'unknown', reason: `systemd's variables are set but no unit could be confirmed to run this process (pid ${pid}); restart it with "mymaestro restart" or systemctl` };
    }
  }
  if (useCache) cache.set(key, { at: Date.now(), value });
  return value;
}

/** The launchd job label when this process is that job's own process, else null. */
function launchdLabel(opts = {}) { const s = supervisor(opts); return s.kind === 'launchd' ? s.label : null; }

/** A log file the current user can append to: <project>/data/restart.log, else the temp dir. */
function restartLogPath(projectDir, fsImpl = fs) {
  const data = path.join(projectDir, 'data');
  try { fsImpl.mkdirSync(data, { recursive: true }); fsImpl.accessSync(data, fs.constants.W_OK); return path.join(data, 'restart.log'); } catch {}
  return path.join(os.tmpdir(), 'agent-hub-restart.log');
}

/**
 * requestRestart({ projectDir, port, reason, by }) -> { mode: 'systemd'|'launchd'|'relaunch', note, log? } | { error }
 * Never throws. Test hooks: env, platform, spawnImpl, execImpl, setTimeoutImpl, killImpl, fsImpl, argv, pid.
 */
function requestRestart({ projectDir, port = null, reason = '', by = 'owner', env = process.env, platform = process.platform, spawnImpl = null, execImpl = execFileSync, setTimeoutImpl = setTimeout, killImpl = (pid, sig) => process.kill(pid, sig), fsImpl = fs, argv = process.argv.slice(1), pid = process.pid, uid = (os.userInfo && os.userInfo().uid), folder = null, log = console.log } = {}) {
  const selfExit = () => {
    const t = setTimeoutImpl(() => { try { killImpl(pid, 'SIGUSR2'); } catch (e) { log(`[restart] could not signal myself: ${e.message}`); } }, SYSTEMD_DELAY_MS);
    if (t && t.unref) t.unref();
  };
  const sup = supervisor({ projectDir, env, platform, pid, uid, execImpl, fsImpl, folder, fresh: true });
  if (sup.kind === 'unknown') {
    log(`[restart] ${by}: ${reason || 'restart'} — refused: ${sup.reason}`);
    return { mode: 'refused', error: `Not restarted: ${sup.reason}.` };
  }
  if (sup.kind === 'systemd') {
    log(`[restart] ${by}: ${reason || 'restart'} — running under systemd: exiting with code ${EXIT_RESTART} in ${SYSTEMD_DELAY_MS} ms; systemd brings the service back on the new code`);
    selfExit();
    return { mode: 'systemd', note: `the service exits with code ${EXIT_RESTART} in ${SYSTEMD_DELAY_MS / 1000} s and systemd restarts it` };
  }
  if (sup.kind === 'launchd') {
    const label = sup.label;
    const target = `gui/${uid}/${label}`;
    log(`[restart] ${by}: ${reason || 'restart'} — launchd job ${label}: launchctl kickstart -k in ${SYSTEMD_DELAY_MS} ms`);
    const t = setTimeoutImpl(() => { try { execImpl('launchctl', ['kickstart', '-k', target], { stdio: 'ignore', timeout: 10000 }); } catch (e) { log(`[restart] launchctl kickstart failed: ${e.message}`); } }, SYSTEMD_DELAY_MS);
    if (t && t.unref) t.unref();
    return { mode: 'launchd', note: `launchd restarts ${label} in ${SYSTEMD_DELAY_MS / 1000} s` };
  }
  const script = path.join(projectDir, 'scripts', 'relaunch.js');
  if (!fsImpl.existsSync(script)) return { mode: 'relaunch', error: 'scripts/relaunch.js not found' };
  const logFile = restartLogPath(projectDir, fsImpl);
  let fd = 'ignore';
  try { fd = fsImpl.openSync(logFile, 'a'); } catch { fd = 'ignore'; }
  const hubPort = Number(port) || Number(env.PORT) || 8888;
  const spawn = spawnImpl || require('child_process').spawn;
  const relaunchArgs = [script, '--dir', projectDir, '--pid', String(pid), '--port', String(hubPort), '--argv', JSON.stringify(argv.length ? argv : ['server.js'])];
  log(`[restart] ${by}: ${reason || 'restart'} — no supervisor: scripts/relaunch.js takes over (log: ${fd === 'ignore' ? 'none' : logFile}); this process exits in ${SYSTEMD_DELAY_MS} ms`);
  try {
    const child = spawn(process.execPath, relaunchArgs, { cwd: projectDir, detached: true, stdio: ['ignore', fd, fd], env });
    if (child && child.unref) child.unref();
  } catch (e) {
    return { mode: 'relaunch', error: `could not start scripts/relaunch.js: ${e.message}` };
  }
  selfExit();
  return { mode: 'relaunch', note: 'the new server starts within about 10 s; the page confirms by boot id', log: fd === 'ignore' ? null : logFile };
}

/** Last lines of the restart log and the server log, for the page to show when a restart did not happen. */
function restartLogTail(projectDir, { lines = 40, fsImpl = fs } = {}) {
  const out = {};
  for (const [key, p] of [['restart', restartLogPath(projectDir, fsImpl)], ['server', path.join(projectDir, 'server.log')], ['serverData', path.join(projectDir, 'data', 'server.log')]]) {
    try { out[key] = { path: p, tail: fsImpl.readFileSync(p, 'utf8').split('\n').slice(-lines).join('\n') }; } catch { /* absent */ }
  }
  return out;
}

module.exports = { requestRestart, supervisor, underSystemd, launchdLabel, launchdJobPid, systemdMainPid, procInfo, isWrapper, runsUs, startedByManager, restartLogPath, restartLogTail, EXIT_RESTART, SYSTEMD_DELAY_MS, LAUNCHD_LABEL };
