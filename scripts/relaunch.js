#!/usr/bin/env node
'use strict';
/**
 * relaunch.js — restarts an My Maestro AI that nothing supervises (no systemd, no launchd): started by hand, by nohup,
 * or by an old restart. Spawned detached by lib/restart with the hub's own node binary, environment and arguments,
 * so the new server starts exactly as the old one did. No bash, no lsof, no profile sourcing, no PATH guessing.
 *
 *   node scripts/relaunch.js --dir <projectDir> --pid <oldPid> --port <port> --argv '["server.js"]' [--grace 25]
 *
 * 1. waits for the old process to exit (it exits itself after lib/restart signals it); after the grace period it
 *    is told to stop, then killed
 * 2. waits for the port to be free
 * 3. starts the new server detached, output appended to server.log (or data/server.log, or the temp dir)
 * 4. waits for /api/health to answer and reports the new pid and boot id
 * Everything is logged to stdout, which lib/restart points at data/restart.log, so a failed restart is visible.
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const dir = path.resolve(args.dir || process.cwd());
const oldPid = Number(args.pid) || 0;
const port = Number(args.port) || 8888;
const graceMs = (Number(args.grace) || 25) * 1000;
let argv; try { argv = JSON.parse(args.argv || '["server.js"]'); } catch { argv = ['server.js']; }

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (m) => process.stdout.write(`[relaunch] ${ts()} ${m}\n`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const portFree = () => new Promise(resolve => {
  const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(false); });
  s.on('error', () => resolve(true));
  s.setTimeout(1000, () => { s.destroy(); resolve(false); });
});
// Up = the new server answers: 200 with its boot id, or 401 (health is behind the sign-in on a hub with accounts).
// 503 is "starting", anything else is not up yet.
const health = () => new Promise(resolve => {
  const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 3000 }, res => {
    let body = ''; res.on('data', c => body += c);
    res.on('end', () => {
      if (res.statusCode === 200) { try { resolve(JSON.parse(body)); } catch { resolve({}); } }
      else if (res.statusCode === 401) resolve({ signInRequired: true });
      else resolve(null);
    });
  });
  req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
});

function serverLogPath() {
  for (const p of [path.join(dir, 'server.log'), path.join(dir, 'data', 'server.log'), path.join(os.tmpdir(), 'agent-hub-server.log')]) {
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); const fd = fs.openSync(p, 'a'); fs.closeSync(fd); return p; } catch {}
  }
  return null;
}

(async () => {
  log(`restarting hub in ${dir} on port ${port}; old pid ${oldPid || '(unknown)'}; node ${process.execPath}; argv ${JSON.stringify(argv)}`);
  if (oldPid && oldPid !== process.pid) {
    const t0 = Date.now();
    while (alive(oldPid) && Date.now() - t0 < graceMs) await sleep(500);
    if (alive(oldPid)) { log(`old process ${oldPid} still running after ${graceMs / 1000} s; sending SIGTERM`); try { process.kill(oldPid, 'SIGTERM'); } catch {} await sleep(5000); }
    if (alive(oldPid)) { log(`old process ${oldPid} ignored SIGTERM; sending SIGKILL`); try { process.kill(oldPid, 'SIGKILL'); } catch {} await sleep(1000); }
    log(alive(oldPid) ? `old process ${oldPid} could not be stopped` : `old process ${oldPid} has exited`);
  }
  const t1 = Date.now();
  while (!(await portFree()) && Date.now() - t1 < 20000) await sleep(500);
  if (!(await portFree())) log(`port ${port} is still in use; starting anyway (the new server will say if it cannot bind)`);
  const out = serverLogPath();
  const fd = out ? fs.openSync(out, 'a') : 'ignore';
  const child = spawn(process.execPath, argv, { cwd: dir, env: process.env, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  try { fs.writeFileSync(path.join(dir, '.server.pid'), String(child.pid)); } catch {}
  log(`started pid ${child.pid} (output: ${out || 'discarded'}); waiting for /api/health`);
  const t2 = Date.now();
  let h = null;
  while (!h && Date.now() - t2 < 90000) { await sleep(1000); if (!alive(child.pid)) break; h = await health(); }
  if (h) { log(`✅ hub is up: pid ${h.pid || child.pid}${h.bootId ? `, boot ${h.bootId}` : ''}${h.signInRequired ? ' (answering; sign-in required)' : ''}, ${Math.round((Date.now() - t2) / 1000)} s`); process.exit(0); }
  log(`❌ the new server did not answer /api/health${alive(child.pid) ? ' within 90 s' : ' (it exited)'}; see ${out || 'its output'}`);
  if (out) { try { const tail = fs.readFileSync(out, 'utf8').split('\n').slice(-20).join('\n'); log(`last lines of ${out}:\n${tail}`); } catch {} }
  process.exit(1);
})().catch(e => { log(`❌ ${e.stack || e.message}`); process.exit(1); });
