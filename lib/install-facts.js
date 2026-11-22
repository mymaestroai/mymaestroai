'use strict';
/**
 * Facts about the computer the hub runs on, read-only: the operating system, whether systemd is there, the hostname, the Tailscale
 * state and this computer's own Tailscale addresses, the hub's port and the free disk space of its data folder.
 * It runs only `tailscale status --json` and reads files. Of Tailscale's answer only the backend state, the TUN flag, this computer's own
 * DNS name and its own addresses are kept; the peer list is never read out or returned. The only addresses ever offered are IPv4 ones
 * inside 100.64.0.0/10 that Tailscale reports as this computer's own (Self.TailscaleIPs).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CLI_CANDIDATES = ['tailscale', '/usr/bin/tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
const KINDS = ['tailnet_host', 'tailnet_ip', 'hostname', 'hub_port', 'os', 'has_systemd', 'time_zone'];

/** This computer's IANA time zone, e.g. "America/New_York"; '' when it cannot be told. */
function defaultTimeZone() {
  try { return String(Intl.DateTimeFormat().resolvedOptions().timeZone || ''); } catch { return ''; }
}
const CACHE_MS = 30000;

/** True only for a dotted IPv4 address inside 100.64.0.0/10 (100.64.0.0 to 100.127.255.255). */
function isTailnetIp(ip) {
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(String(ip == null ? '' : ip));
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some(n => n > 255)) return false;
  return o[0] === 100 && o[1] >= 64 && o[1] <= 127;
}

function defaultRun(file, args, { timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
        if (err.code === 'ENOENT' || err.code === 'EACCES') return resolve({ code: err.code, stdout: '', stderr: '', missing: true });
        if (err.killed || err.signal) return resolve({ code: null, stdout: '', stderr: '', timedOut: true });
        resolve({ code: typeof err.code === 'number' ? err.code : 1, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    } catch (e) { resolve({ code: e && e.code ? e.code : 'ENOENT', stdout: '', stderr: '', missing: true }); }
  });
}

/** One try of the CLI at `file`: { kind: 'missing' | 'timeout' | 'answered', code, stdout, stderr }. Never throws. */
async function tryCli(run, file, timeoutMs) {
  let r;
  try { r = await run(file, ['status', '--json'], { timeout: timeoutMs }); }
  catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'EACCES')) return { kind: 'missing' };
    return { kind: 'timeout' };
  }
  if (!r || typeof r !== 'object') return { kind: 'timeout' };
  if (r.missing || r.code === 'ENOENT' || r.code === 'EACCES') return { kind: 'missing' };
  if (r.timedOut || r.code === null || r.code === undefined || r.code === 'ETIMEDOUT') return { kind: 'timeout' };
  return { kind: 'answered', code: r.code, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

function readStatus(stdout) {
  let j;
  try { j = JSON.parse(stdout); } catch { return { state: 'unknown', detail: "Tailscale's answer could not be read." }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { state: 'unknown', detail: "Tailscale's answer could not be read." };
  const self = j.Self && typeof j.Self === 'object' ? j.Self : {};
  const ips = (Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : []).filter(isTailnetIp);
  const host = typeof self.DNSName === 'string' ? self.DNSName.trim().replace(/\.$/, '') : '';
  const userspace = j.TUN === false;
  const bs = String(j.BackendState || '');
  let state, detail;
  if (bs === 'Running') { state = 'running'; detail = ips.length ? 'Signed in.' : 'Signed in, but no private-network address is reported for this computer.'; }
  else if (bs === 'NeedsLogin' || bs === 'NoState' || bs === 'Stopped') { state = 'logged-out'; detail = 'Tailscale is not signed in.'; }
  else { state = 'unknown'; detail = bs ? `Tailscale reports "${bs.slice(0, 40)}".` : 'Tailscale gave no state.'; }
  return { state, detail, userspace, host: state === 'running' ? host : '', ips: state === 'running' ? ips : [] };
}

function createInstallFacts({ platform = process.platform, run = defaultRun, fsx = fs, timeoutMs = 3000, env = process.env, dataDir, hostname = () => os.hostname(), timeZone = defaultTimeZone, now = Date.now } = {}) {
  let cache = null, pending = null;
  const dir = dataDir || path.join(__dirname, '..', 'data');

  async function tailscale() {
    const out = { state: 'unknown', userspace: false, cli: '', host: '', ips: [], detail: '' };
    let found = null, existing = false;
    for (const file of CLI_CANDIDATES) {
      const t = await tryCli(run, file, timeoutMs);
      if (t.kind === 'missing') continue;
      existing = true;
      if (t.kind === 'timeout') continue;
      const s = (t.stdout || '').trim();
      if (!s || (t.code !== 0 && s[0] !== '{')) continue;   // it ran but the daemon did not answer: try the next, then report not-running
      found = { file, s };
      break;
    }
    if (!found) {
      if (!existing) return { ...out, state: 'not-installed', detail: 'The Tailscale command was not found.' };
      return { ...out, state: 'not-running', detail: 'Tailscale is installed but its background service did not answer.' };
    }
    return { ...out, cli: found.file, ...readStatus(found.s) };
  }

  async function freeDiskMb() {
    if (!fsx || typeof fsx.statfs !== 'function') return null;
    const look = (p) => new Promise((resolve) => {
      let settled = false;
      const done = (s) => { if (!settled) { settled = true; resolve(s); } };
      try {
        const r = fsx.statfs(p, (e, s) => done(e ? null : s));
        if (r && typeof r.then === 'function') r.then(done, () => done(null));
      } catch { done(null); }
    });
    let s = await look(dir);
    if (!s) s = await look(path.dirname(dir));
    if (!s || !Number.isFinite(Number(s.bavail)) || !Number.isFinite(Number(s.bsize))) return null;
    return Math.floor(Number(s.bavail) * Number(s.bsize) / 1048576);
  }

  async function collect() {
    const supported = platform === 'linux' || platform === 'darwin';
    let has_systemd = false;
    if (platform === 'linux') { try { has_systemd = !!fsx.existsSync('/run/systemd/system'); } catch { has_systemd = false; } }
    let host = ''; try { host = String(hostname() || ''); } catch { /* none */ }
    let time_zone = ''; try { time_zone = String((typeof timeZone === 'function' ? timeZone() : timeZone) || '').trim(); } catch { time_zone = ''; }
    const ts = supported ? await tailscale() : { state: 'unknown', userspace: false, cli: '', host: '', ips: [], detail: 'Not checked on this system.' };
    const port = Number.parseInt(env && env.PORT, 10);
    let free = null; try { free = await freeDiskMb(); } catch { free = null; }
    return { os: platform, supported, has_systemd, hostname: host, tailscale: ts, hub_port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null, free_disk_mb: free, time_zone };
  }

  // A look that did not find Tailscale up (missing, signed out, silent, unreadable) is shown but never kept, so fixing it shows at once.
  // A look that itself fails (rejects) is never kept either: the cache is only written on success.
  const failed = (v) => !!(v && v.supported && v.tailscale && v.tailscale.state !== 'running');

  // get({ fresh: true }) ignores what was kept (the page asked again) and does its own look; its answer replaces the kept one.
  async function get({ fresh = false } = {}) {
    if (!fresh && cache && now() - cache.at < CACHE_MS) return JSON.parse(JSON.stringify(cache.value));
    if (fresh || !pending) {
      const p = collect().then(v => { if (failed(v)) cache = null; else cache = { at: now(), value: v }; return v; }).finally(() => { if (pending === p) pending = null; });
      pending = p;
    }
    return JSON.parse(JSON.stringify(await pending));
  }
  return { get };
}

/** suggestFor(kind, facts) -> { value, candidates } or null. Addresses are re-checked: only tailnet IPv4 ones are ever offered. */
function suggestFor(kind, facts) {
  if (!KINDS.includes(kind) || !facts || typeof facts !== 'object') return null;
  const ts = facts.tailscale && typeof facts.tailscale === 'object' ? facts.tailscale : {};
  let list = [];
  switch (kind) {
    case 'tailnet_host': list = typeof ts.host === 'string' && ts.host ? [ts.host] : []; break;
    case 'tailnet_ip': list = (Array.isArray(ts.ips) ? ts.ips : []).filter(isTailnetIp); break;
    case 'hostname': list = typeof facts.hostname === 'string' && facts.hostname ? [facts.hostname] : []; break;
    case 'hub_port': list = Number.isInteger(facts.hub_port) ? [facts.hub_port] : []; break;
    case 'os': list = typeof facts.os === 'string' && facts.os ? [facts.os] : []; break;
    case 'has_systemd': list = typeof facts.has_systemd === 'boolean' ? [facts.has_systemd] : []; break;
    case 'time_zone': list = typeof facts.time_zone === 'string' && facts.time_zone ? [facts.time_zone] : []; break;
  }
  return list.length ? { value: list[0], candidates: list } : null;
}

module.exports = { createInstallFacts, suggestFor, isTailnetIp, SUGGEST_KINDS: KINDS, CLI_CANDIDATES };
