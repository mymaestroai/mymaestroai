'use strict';
// lib/scope-wrap.js: run an agent's own command (the Bash tool, the Claude and Codex clients) in a transient systemd
// scope with the memory limit from lib/mem-limit.js, so a runaway there is killed inside its own scope and never
// counts against the hub's unit.
//
//   canScope({limit})             true when `systemd-run --user --scope --quiet --collect [-p MemoryMax=<limit> -p MemorySwapMax=0] true`
//                                 works (Linux only): the probe uses memLimit.scopeProps(limit), the exact launch properties. A success is kept for 5 minutes, a
//                                 failure is probed again after 60 s; resetCache() forgets both (a run that failed to start).
//   wrap(file, args, {label})     -> { file, args }: `systemd-run --user --scope ... --unit=hub-cmd-<random> <props> -- file args`
//                                 when canScope(), else the same file and args unchanged.
//
// `systemd-run --scope` does NOT start the command as a child of a service: it registers a scope and then execs the
// command in place. The pid, stdio pipes, process group and signals stay the caller's, so a caller that spawns
// `systemd-run ... -- cmd` with detached:true and kills `-pid` on timeout, or that watches the pid (lib/client-watch),
// works as before (test/scope-wrap.test.js proves it with a fake that execs).
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const memLimit = require('./mem-limit');

const RETRY_MS = 60000;
const OK_MS = 5 * 60000;
const FRESH_MS = 60000;          // a 'fresh' caller (the clients) accepts a cached answer up to this old
const FRESH_TIMEOUT_MS = 2000;   // and never blocks the hub longer than this for a probe
// What systemd-run prints when the scope itself could not be made (the command never started).
const SCOPE_FAIL_RE = /^(Failed to (start transient scope|connect to bus|create bus connection)|Unknown assignment|Failed to determine)/m;
let cache = null;   // { ok, at }

/** systemd-run --user finds the user's manager through these (only added when missing); same logic as jobs.js probeEnv. */
function scopeEnv(env = process.env, { uid = (process.getuid ? process.getuid() : null), exists = fs.existsSync } = {}) {
  const out = { ...env };
  if (!out.XDG_RUNTIME_DIR && uid !== null && exists(`/run/user/${uid}`)) out.XDG_RUNTIME_DIR = `/run/user/${uid}`;
  if (!out.DBUS_SESSION_BUS_ADDRESS && out.XDG_RUNTIME_DIR && exists(`${out.XDG_RUNTIME_DIR}/bus`)) out.DBUS_SESSION_BUS_ADDRESS = `unix:path=${out.XDG_RUNTIME_DIR}/bus`;
  return out;
}

function probe({ platform = process.platform, spawn = spawnSync, env = process.env, limit, timeoutMs = 5000 } = {}) {
  if (platform !== 'linux') return false;
  try {
    const props = memLimit.scopeProps(limit);   // the exact properties a launch uses
    const r = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', ...props, 'true'], { stdio: 'ignore', timeout: timeoutMs, env: scopeEnv(env) });
    return !!r && r.status === 0;
  } catch { return false; }
}

/** opts (tests): platform, spawn, now, fresh (ignore the cache). */
function canScope(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'linux') return false;
  const now = (opts.now || Date.now)();
  // fresh (the clients, which cannot respawn): look again only when the cached answer is older than 60 s, and never wait more than 2 s
  const maxAge = opts.fresh ? Math.min(FRESH_MS, cache && cache.ok ? OK_MS : RETRY_MS) : (cache && cache.ok ? OK_MS : RETRY_MS);
  if (cache && now - cache.at < maxAge) return cache.ok;
  const ok = probe(opts.fresh ? { ...opts, timeoutMs: FRESH_TIMEOUT_MS } : opts);
  if (!opts.noCache) cache = { ok, at: now };
  return ok;
}

function resetCache() { cache = null; }

/** The limit and the can-scope answer are read per call, so a changed setting applies to the next command. */
function wrap(file, args, { label = 'cmd', limit, can, getSetting, fresh = false } = {}) {
  const a = Array.isArray(args) ? args : [];
  const bytes = limit !== undefined ? limit : memLimit.limitBytes(getSetting ? { getSetting } : {});
  // fresh: probe again right before this spawn (callers that cannot respawn when the scope fails to start: the clients)
  const ok = can !== undefined ? can : canScope({ limit: bytes, fresh });
  if (!ok) return { file, args: a };
  // systemd 255's `systemd-run --scope` rejects OOMScoreAdjust ("Unknown assignment"), which would fail every command:
  // scope units take only resource-control properties, so that one is dropped here (the memory ones are kept).
  const props = memLimit.scopeProps(bytes);
  const scopeOnly = [];
  for (let i = 0; i < props.length; i += 2) if (!/^OOMScoreAdjust=/.test(props[i + 1])) scopeOnly.push(props[i], props[i + 1]);
  const unit = `hub-cmd-${crypto.randomBytes(5).toString('hex')}`;
  const desc = `My Maestro AI ${String(label).replace(/[^\w .:-]/g, '').slice(0, 60)}`;
  return {
    file: 'systemd-run',
    args: ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, `--description=${desc}`, ...scopeOnly, '--', file, ...a],
  };
}

/** The env systemd-run needs to find the user's manager (add to a spawn env when wrapping). */
function envFor(env) { return scopeEnv(env); }

/** A run that failed before its command started: systemd-run's own error on stderr, no stdout. */
function failedToStart({ code, stdout, stderr } = {}) {
  return code !== 0 && code !== null && !String(stdout || '') && SCOPE_FAIL_RE.test(String(stderr || ''));
}

module.exports = { canScope, wrap, envFor, resetCache, failedToStart, SCOPE_FAIL_RE, RETRY_MS, OK_MS };
