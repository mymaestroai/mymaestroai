'use strict';
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { spawn: realSpawn } = require('node:child_process');

const SUPERVISOR_MARKER = '--mm-claude-supervisor';

function startGroup(bin, args, { env, stdio, spawn, installer = false,
  kill = process.kill.bind(process), setTimer = setTimeout } = {}) {
  const guard = require('./claude-signin-guard');
  if (!spawn) spawn = realSpawn;
  // The program-path rule holds for EVERY spawn function, injected or not (a wrapper around the real spawn is still the real spawn).
  // Direct callers must pass the same installer check as installClient.
  if (installer) guard.guardInstaller(spawn);
  else guard.guardProgram(bin);
  // The supervisor (and the program it runs) keeps the node --test signal even when the caller gave it a bare environment.
  const ctx = process.env.NODE_TEST_CONTEXT;
  const leader = spawn(process.execPath, [path.join(__dirname, 'claude-signin-supervisor.js'), SUPERVISOR_MARKER], {
    detached: true, env: env && ctx ? { ...env, NODE_TEST_CONTEXT: ctx } : env, stdio: [...stdio, 'ipc']
  });
  const job = new EventEmitter();
  Object.assign(job, { stdin: leader.stdin, stdout: leader.stdout, stderr: leader.stderr });
  let reported = false, stopping = false, polling = false;
  let drained;
  job.drained = new Promise(resolve => { drained = resolve; });
  function result(code) {
    if (reported) return;
    reported = true;
    job.emit('result', code);
  }
  function probe() {
    if (!leader.pid) { drained(); return; }
    try { kill(-leader.pid, 0); }
    catch (err) {
      if (err.code === 'ESRCH') { drained(); return; }
    }
    // Presence and EPERM are both inconclusive. Never signal this numeric ID.
    setTimer(probe, 500);
  }
  function onLeaderExit() {
    if (polling) return;
    polling = true;
    result(1);
    probe();
  }
  job.stop = () => {
    if (stopping || !leader.connected) return;
    stopping = true;
    leader.send({ op: 'stop' }, () => {});
  };
  // Disconnect is the synchronous request used on parent shutdown. An actual
  // parent crash also closes the IPC channel without needing this hook.
  job.disconnect = () => { if (leader.connected) leader.disconnect(); };
  leader.on('message', m => { if (m?.op === 'result') result(m.code); });
  leader.once('exit', onLeaderExit);
  leader.once('close', onLeaderExit);
  leader.on('error', () => {
    if (!leader.pid) onLeaderExit(); // spawn failed; no group was created
    else job.disconnect();
  });
  if (leader.connected) leader.send({ op: 'start', bin, args, allowReal: guard.realAllowed() }, err => {
    if (err) job.disconnect();
  });
  return job;
}

module.exports = { startGroup, SUPERVISOR_MARKER };
