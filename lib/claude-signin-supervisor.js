'use strict';

// This process is the detached group leader. Only it sends destructive group
// signals, always to its own current group. The parent addresses it over IPC.
function supervise({ channel = process, spawn = null,
  kill = process.kill.bind(process), setTimer = setTimeout, graceMs = 3000 } = {}) {
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
      let sp = spawn;
      if (!sp) { require('./claude-signin-guard').guardProgram(msg.bin); sp = require('node:child_process').spawn; }   // default spawn: never a real program under node --test
      const worker = sp(msg.bin, msg.args, { stdio: 'inherit', detached: false });
      worker.once('error', () => report(1));
      worker.once('exit', code => report(code ?? 1));
    } catch { report(1); }
  });
  if (!channel.connected) hardStop();
}
if (require.main === module) supervise();
module.exports = { supervise };
