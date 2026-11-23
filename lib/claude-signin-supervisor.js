'use strict';

const MARKER = '--mm-claude-supervisor';   // startGroup passes it; the same string is lib/claude-signin-group's SUPERVISOR_MARKER

// This process is the detached group leader. Only it sends destructive group
// signals, always to its own current group. The parent addresses it over IPC.
// It refuses to start (exit 1, no signal to any group) unless it has an IPC channel AND the marker argument: started any other
// way it could be a stray `node` run whose process group is somebody else's.
function supervise({ channel = process, spawn = null, argv = process.argv, exit = (c) => process.exit(c),
  kill = process.kill.bind(process), setTimer = setTimeout, graceMs = 3000 } = {}) {
  if (!channel.connected || !argv.includes(MARKER)) { exit(1); return; }
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
      if (sp === realSpawn) require('./claude-signin-guard').guardProgramWith(msg.allowReal === true, msg.bin);
      const worker = sp(msg.bin, msg.args, { stdio: 'inherit', detached: false });
      worker.once('error', () => report(1));
      worker.once('exit', code => report(code ?? 1));
    } catch { report(1); }
  });
}
if (require.main === module) supervise();
module.exports = { supervise, MARKER };
