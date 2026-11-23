'use strict';

const MARKER = '--mm-claude-supervisor';   // startGroup passes it; the same string is lib/claude-signin-group's SUPERVISOR_MARKER

// A POSIX process-group leader cannot join another group during its lifetime.
function ownsGroup({ platform = process.platform, pid = process.pid,
  read = require('node:fs').readFileSync, exec = require('node:child_process').execFileSync } = {}) {
  try {
    if (platform === 'linux') {
      const stat = read('/proc/self/stat', 'utf8');
      const end = stat.lastIndexOf(')');
      return end >= 0 && Number(stat.slice(end + 1).trim().split(/\s+/)[2]) === pid;
    }
    if (platform === 'darwin') {
      const pgid = exec('/bin/ps', ['-p', String(pid), '-o', 'pgid='], {
        encoding: 'utf8', timeout: 1000, env: { LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      return /^\d+$/.test(pgid) && Number(pgid) === pid;
    }
  } catch { /* ownership could not be established */ }
  return false;
}

// This process is the detached group leader. Only it sends destructive group
// signals, always to its own current group. The parent addresses it over IPC.
// It refuses to start (exit 1, no signal to any group) unless it has an IPC channel AND the marker argument: started any other
// way it could be a stray `node` run whose process group is somebody else's.
function supervise({ channel = process, spawn = null, argv = process.argv, ownsProcessGroup = ownsGroup, exit = (c) => process.exit(c),
  kill = process.kill.bind(process), setTimer = setTimeout, graceMs = 3000 } = {}) {
  if (!channel.connected || !argv.includes(MARKER) || !ownsProcessGroup()) { exit(1); return; }
  let started = false, stopping = false;
  function hardStop() { kill(0, 'SIGKILL'); }
  function stop() {
    if (stopping) return;
    stopping = true;
    setTimer(hardStop, graceMs);
    kill(0, 'SIGTERM');
  }
  channel.on('SIGTERM', stop);
  channel.on('disconnect', hardStop);
  channel.on('message', msg => {
    if (msg?.op === 'stop') { stop(); return; }
    if (msg?.op !== 'start' || started || stopping) return;
    started = true;
    let reported = false;
    function report(code) {
      if (reported) return;
      reported = true;
      if (!channel.connected) { hardStop(); return; }
      channel.send({ op: 'result', code }, err => {
        if (err) hardStop();
        else stop();
      });
    }
    try {
      const realSpawn = require('node:child_process').spawn;
      const sp = spawn || realSpawn;
      // The same boundary rule as the parent's, with the parent's opt-in: the real spawn never runs a refused program.
      require('./claude-signin-guard').guardProgramWith(msg.allowReal === true, msg.bin);
      const worker = sp(msg.bin, msg.args, { stdio: 'inherit', detached: false });
      worker.once('error', () => report(1));
      worker.once('exit', code => report(code ?? 1));
    } catch { report(1); }
  });
}
if (require.main === module) supervise();
module.exports = { supervise, ownsGroup, MARKER };
