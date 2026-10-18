'use strict';
// restart.js — one way to restart the hub from inside it (the UI button, the RestartHub tool), whatever supervises it.
//
//   systemd (Linux service, user or system scope): the process asks itself to exit with code 75 after a short delay
//     (SIGUSR2 -> graceful shutdown -> exit 75). systemd restarts the unit on the new code whether it has
//     Restart=always or Restart=on-failure, since 75 is a failure code. (A tester found the old script path
//     never worked on systemd installs: safe-restart.sh appended to a root-owned server.log and died silently.)
//   launchd (macOS service installed by setup): launchctl kickstart -k restarts the job on the new code.
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
const LAUNCHD_LABEL = 'com.agent-hub';

/** True when this process was started by systemd (as a service, user or system scope). */
function underSystemd(env = process.env) { return !!(env.INVOCATION_ID || env.JOURNAL_STREAM || env.NOTIFY_SOCKET); }

/** The launchd job label when this process runs as a macOS launchd service, else null. */
function launchdLabel({ env = process.env, platform = process.platform, uid = (os.userInfo && os.userInfo().uid), execImpl = execFileSync } = {}) {
  if (platform !== 'darwin') return null;
  const fromEnv = String(env.XPC_SERVICE_NAME || '');
  if (/^[a-z][\w.-]*agent-hub[\w.-]*$/i.test(fromEnv)) return fromEnv;
  try { execImpl('launchctl', ['print', `gui/${uid}/${LAUNCHD_LABEL}`], { stdio: 'ignore', timeout: 3000 }); return LAUNCHD_LABEL; } catch { return null; }
}

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
function requestRestart({ projectDir, port = null, reason = '', by = 'owner', env = process.env, platform = process.platform, spawnImpl = null, execImpl = execFileSync, setTimeoutImpl = setTimeout, killImpl = (pid, sig) => process.kill(pid, sig), fsImpl = fs, argv = process.argv.slice(1), pid = process.pid, log = console.log } = {}) {
  const selfExit = () => {
    const t = setTimeoutImpl(() => { try { killImpl(pid, 'SIGUSR2'); } catch (e) { log(`[restart] could not signal myself: ${e.message}`); } }, SYSTEMD_DELAY_MS);
    if (t && t.unref) t.unref();
  };
  if (underSystemd(env)) {
    log(`[restart] ${by}: ${reason || 'restart'} — running under systemd: exiting with code ${EXIT_RESTART} in ${SYSTEMD_DELAY_MS} ms; systemd brings the service back on the new code`);
    selfExit();
    return { mode: 'systemd', note: `the service exits with code ${EXIT_RESTART} in ${SYSTEMD_DELAY_MS / 1000} s and systemd restarts it` };
  }
  const label = launchdLabel({ env, platform, execImpl });
  if (label) {
    const target = `gui/${(os.userInfo && os.userInfo().uid)}/${label}`;
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

module.exports = { requestRestart, underSystemd, launchdLabel, restartLogPath, restartLogTail, EXIT_RESTART, SYSTEMD_DELAY_MS, LAUNCHD_LABEL };
