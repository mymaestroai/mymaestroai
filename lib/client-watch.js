'use strict';
/**
 * client-watch.js — keeps a Claude client turn from being held hostage by its own shell commands.
 *
 * What happened (GP, 2026-10-13): a `grep` with a pathological pattern ran for 20+ minutes; the client's Bash tool
 * timed out and the model went on to finish its reply (stop_reason end_turn), but the client process waits for its
 * child shells before exiting, so the hub never received the result, the agent stayed "busy", and the owner's next
 * message queued behind a finished turn.
 *
 * The hub supplies the SDK's spawnClaudeCodeProcess so it knows the client's pid for the turn. When the model has
 * ended its turn and no result has arrived within `graceMs`, any process still running under the client is listed,
 * logged, reported in the chat, and killed, so the client can exit and the turn can close. A cancelled turn kills
 * the whole tree. Portable: process trees come from `ps` (Linux reads etimes, macOS reads etime).
 */
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const DEFAULT_GRACE_MS = 45000;
const RECHECK_MS = 30000;

/** [{ pid, ppid, etimes, args }] for every process; via ps so it works on macOS too. */
async function processTable(exec = execFileAsync, platform = process.platform) {
  const rows = [];
  if (platform === 'linux') {
    const { stdout } = await exec('ps', ['-eo', 'pid=,ppid=,etimes=,args='], { maxBuffer: 16 * 1024 * 1024 });
    for (const line of String(stdout).split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), etimes: Number(m[3]), args: m[4] });
    }
    return rows;
  }
  // macOS: ps has no etimes, only etime = [[dd-]hh:]mm:ss (there -e lists every process, as on Linux)
  const { stdout } = await exec('ps', ['-eo', 'pid=,ppid=,etime=,args='], { maxBuffer: 16 * 1024 * 1024 });
  for (const line of String(stdout).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]), ppid = Number(m[2]), etimes = parseEtime(m[3]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || etimes === null) continue;
    rows.push({ pid, ppid, etimes, args: m[4] });
  }
  return rows;
}

/** ps etime ([[dd-]hh:]mm:ss) -> seconds, or null when malformed. */
function parseEtime(str) {
  const m = String(str).trim().match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const hasDay = m[1] !== undefined;
  const d = hasDay ? Number(m[1]) : 0;
  const h = m[2] !== undefined ? Number(m[2]) : 0;
  const mi = Number(m[3]), s = Number(m[4]);
  if (mi > 59 || s > 59) return null;
  if (hasDay && h > 23) return null;
  const total = d * 86400 + h * 3600 + mi * 60 + s;
  for (const n of [d, h, mi, s, total]) if (!Number.isSafeInteger(n)) return null;
  return total;
}

/** Every process below `pid` (children, grandchildren, ...), deepest last. */
async function descendants(pid, exec = execFileAsync, platform = process.platform) {
  const table = await processTable(exec, platform);
  const byParent = new Map();
  for (const r of table) { if (!byParent.has(r.ppid)) byParent.set(r.ppid, []); byParent.get(r.ppid).push(r); }
  const out = [];
  const walk = (p, depth) => { for (const c of byParent.get(p) || []) { out.push({ ...c, depth }); if (depth < 30) walk(c.pid, depth + 1); } };
  walk(Number(pid), 0);
  return out;
}

/** Kill everything below `pid` (and `pid` itself when includeSelf), deepest first. Returns what was killed. */
async function killTree(pid, { includeSelf = false, signal = 'SIGKILL', exec = execFileAsync, kill = (p, s) => process.kill(p, s), platform = process.platform } = {}) {
  const list = await descendants(pid, exec, platform);
  const victims = list.slice().reverse();
  if (includeSelf) victims.push({ pid: Number(pid), args: '(client)' });
  const killed = [];
  for (const v of victims) { try { kill(v.pid, signal); killed.push(v); } catch { /* already gone */ } }
  return killed;
}

const shortArgs = (a) => String(a || '').replace(/^\/bin\/bash -c source \S+\/shell-snapshots\/\S+ 2>\/dev\/null \|\| true &&[\s\S]*?eval '/, 'bash: ').replace(/' < \/dev\/null$/, '').slice(0, 160);

/**
 * forTurn({ agentName, log, onStderr, onLingering, graceMs }) -> { spawn, expectExit, clear, killAll, pid() }
 *   spawn          hand to the SDK as spawnClaudeCodeProcess; records the pid, consumes stderr, honours the signal
 *   expectExit()   call when the model has ended its turn: starts the grace timer
 *   clear()        call when the result arrived or the turn is over
 *   killAll()      cancel: kill the client and everything under it
 */
function forTurn({ agentName = '?', log = console.log, onStderr = null, onLingering = null, graceMs = DEFAULT_GRACE_MS, exec = execFileAsync, kill = (p, s) => process.kill(p, s), spawnImpl = spawn, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, platform = process.platform } = {}) {
  let child = null, timer = null, ended = false, strikes = 0;
  const pid = () => (child && child.pid) || null;

  function spawnClient(options) {
    child = spawnImpl(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
    if (child.stderr) child.stderr.on('data', (d) => { if (onStderr) { try { onStderr(d); } catch {} } });
    if (options.signal && typeof options.signal.addEventListener === 'function') {
      options.signal.addEventListener('abort', () => { killAll().catch(() => {}); }, { once: true });
    }
    child.on('exit', () => { ended = true; clear(); });
    return child;
  }

  async function sweep() {
    timer = null;
    if (ended || !pid()) return;
    let list = [];
    try { list = await descendants(pid(), exec, platform); } catch (e) { log(`[client-watch] ${agentName}: ps failed: ${e.message}`); return; }
    if (!list.length) { timer = setTimeoutImpl(sweep, RECHECK_MS); if (timer && timer.unref) timer.unref(); return; }   // client busy with itself (flushing); look again
    strikes++;
    const what = list.map(p => `${p.pid} (${p.etimes}s) ${shortArgs(p.args)}`);
    log(`[client-watch] ${agentName}: the reply ended but ${list.length} process(es) still run under the client; killing them so the turn can close: ${what.join(' | ')}`);
    const killed = await killTree(pid(), { exec, kill, platform });
    if (onLingering) { try { onLingering({ killed, strike: strikes }); } catch {} }
    timer = setTimeoutImpl(sweep, RECHECK_MS); if (timer && timer.unref) timer.unref();
  }
  function expectExit() { if (timer || ended) return; timer = setTimeoutImpl(sweep, graceMs); if (timer && timer.unref) timer.unref(); }
  function clear() { if (timer) { clearTimeoutImpl(timer); timer = null; } }
  async function killAll() { clear(); if (!pid()) return []; return killTree(pid(), { includeSelf: true, exec, kill, platform }); }

  return { spawn: spawnClient, expectExit, clear, killAll, pid, descendants: () => (pid() ? descendants(pid(), exec, platform) : Promise.resolve([])) };
}

module.exports = { forTurn, descendants, killTree, processTable, parseEtime, shortArgs, DEFAULT_GRACE_MS, RECHECK_MS };
