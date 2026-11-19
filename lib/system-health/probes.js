'use strict';
// OS probes for the nightly system health check. Every probe has its own time
// limit and never throws: when it cannot tell, it returns null fields or error entries.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const nodeOs = require('os');
const { createOsUpdates } = require('./os-updates');

// ---------- default exec: argument list only, never a shell, never throws ----------
function defaultExec(file, args, { timeoutMs, env } = {}) {
  return new Promise((resolve) => {
    try {
      childProcess.execFile(
        file,
        args,
        { timeout: timeoutMs || 10000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...(env ? { env: { ...process.env, ...env } } : {}) },
        (err, stdout, stderr) => {
          const out = { stdout: String(stdout || ''), stderr: String(stderr || ''), code: 0, timedOut: false };
          if (err) {
            out.timedOut = !!(err.killed && err.signal);
            out.code = typeof err.code === 'number' ? err.code : null;
          }
          resolve(out);
        }
      );
    } catch (e) {
      resolve({ stdout: '', stderr: String((e && e.message) || e), code: null, timedOut: false });
    }
  });
}

// ---------- parsers ----------
function num(s) {
  if (s === undefined || s === null || !/^\d+$/.test(String(s))) return null;
  return Number(s);
}

// Split a df table into { header: [names], row: [tokens] } using the last data line.
function dfTable(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const header = lines[0].replace(/\s+Mounted on\s*$/i, '').split(/\s+/).map((h) => h.toLowerCase());
  const row = lines[lines.length - 1].split(/\s+/);
  return { header, row };
}

function col(table, test) {
  const i = table.header.findIndex(test);
  return i < 0 ? null : table.row[i];
}

// `df -kP`: "Filesystem 1024-blocks Used Available Capacity Mounted on"
function parseDfK(text) {
  const t = dfTable(text);
  if (!t) return null;
  const blocks = num(col(t, (h) => /^\d+[a-z]*-blocks$/.test(h)));
  const used = num(col(t, (h) => h === 'used'));
  const avail = num(col(t, (h) => h === 'available' || h === 'avail'));
  if (blocks === null || avail === null) return null;
  const unit = Number((t.header.find((h) => /-blocks$/.test(h)).match(/^(\d+)/) || [])[1]) || 1024;
  const mult = unit === 1 ? 1024 : unit; // "1K-blocks" -> 1024
  return { totalBytes: blocks * mult, usedBytes: used === null ? null : used * mult, availBytes: avail * mult };
}

// `df -iP` (Linux: Inodes IUsed IFree) or macOS (iused ifree). Parsed by header names.
function parseDfI(text) {
  const t = dfTable(text);
  if (!t) return null;
  let used = num(col(t, (h) => h === 'iused'));
  let free = num(col(t, (h) => h === 'ifree'));
  let total = num(col(t, (h) => h === 'inodes'));
  if (total === null && used !== null && free !== null) total = used + free; // macOS has no total column
  if (total === null || free === null || total === 0) return { inodesTotal: null, inodesFree: null };
  return { inodesTotal: total, inodesFree: free };
}

function parseMeminfo(text) {
  const kb = (name) => {
    const m = new RegExp('^' + name + ':\\s+(\\d+)\\s*kB', 'mi').exec(String(text || ''));
    return m ? Number(m[1]) * 1024 : null;
  };
  return {
    totalBytes: kb('MemTotal'),
    availableBytes: kb('MemAvailable'),
    swapTotalBytes: kb('SwapTotal'),
    swapFreeBytes: kb('SwapFree'),
  };
}

function parseVmStat(text) {
  const s = String(text || '');
  const ps = /page size of (\d+) bytes/i.exec(s);
  const pageSize = ps ? Number(ps[1]) : null;
  const pages = (name) => {
    const m = new RegExp('^Pages ' + name + ':\\s+(\\d+)', 'mi').exec(s);
    return m ? Number(m[1]) : null;
  };
  const free = pages('free');
  const inactive = pages('inactive');
  const speculative = pages('speculative');
  const purgeable = pages('purgeable');
  if (!pageSize || free === null || inactive === null) return null;
  const total = free + inactive + (speculative || 0) + (purgeable || 0);
  return { pageSize, freePages: free, availablePages: total, availableBytes: total * pageSize };
}

// "total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)"
function parseSwapUsage(text) {
  const mult = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  const get = (name) => {
    const m = new RegExp(name + '\\s*=\\s*([\\d.]+)\\s*([KMGT])?', 'i').exec(String(text || ''));
    if (!m) return null;
    return Math.round(Number(m[1]) * (mult[(m[2] || 'B').toUpperCase()] || 1));
  };
  const totalBytes = get('total');
  const usedBytes = get('used');
  if (totalBytes === null || usedBytes === null) return null;
  return { totalBytes, usedBytes, freeBytes: get('free') };
}

// ---------- helpers ----------
function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('ran out of time')), ms);
  });
  return Promise.race([Promise.resolve(promise), limit]).finally(() => clearTimeout(timer));
}

function pct(part, whole) {
  return whole > 0 ? (part / whole) * 100 : null;
}

// ---------- factory ----------
function createProbes(opts = {}) {
  const platform = opts.platform || process.platform;
  const exec = opts.exec || defaultExec;
  const statfs = opts.statfs === null ? null : (opts.statfs || (fs.promises.statfs ? fs.promises.statfs.bind(fs.promises) : null));
  const stat = opts.stat || fs.promises.stat.bind(fs.promises);
  const readFile = opts.readFile || fs.promises.readFile.bind(fs.promises);
  const os = opts.os || nodeOs;
  const nodePath = opts.nodePath || process.execPath;
  const exists = opts.exists || ((p) => fs.promises.access(p).then(() => true, () => false));

  async function safeExec(file, args, timeoutMs, env) {
    try {
      const r = await exec(file, args, env ? { timeoutMs, env } : { timeoutMs });
      return { stdout: String((r && r.stdout) || ''), stderr: String((r && r.stderr) || ''), code: r && r.code !== undefined ? r.code : null, timedOut: !!(r && r.timedOut) };
    } catch (e) {
      return { stdout: '', stderr: String((e && e.message) || e), code: null, timedOut: false };
    }
  }

  // nearest existing path (itself or a parent) and its device
  async function locate(p, timeoutMs) {
    let cur = path.resolve(p);
    for (let i = 0; i < 64; i++) {
      try {
        const st = await withTimeout(stat(cur), timeoutMs);
        return { measured: cur, dev: st.dev };
      } catch (e) {
        if (e && e.message === 'ran out of time') throw e;
        const up = path.dirname(cur);
        if (up === cur) throw e;
        cur = up;
      }
    }
    throw new Error('no existing parent');
  }

  async function measureOne(measured, timeoutMs) {
    if (statfs) {
      const s = await withTimeout(statfs(measured), timeoutMs);
      const bsize = Number(s.bsize);
      const totalBytes = Number(s.blocks) * bsize;
      const availBytes = Number(s.bavail) * bsize;
      const files = Number(s.files);
      const ffree = Number(s.ffree);
      const hasInodes = Number.isFinite(files) && files > 0 && Number.isFinite(ffree);
      return {
        totalBytes, availBytes, availPct: pct(availBytes, totalBytes),
        inodesTotal: hasInodes ? files : null,
        inodesFree: hasInodes ? ffree : null,
        inodesFreePct: hasInodes ? pct(ffree, files) : null,
        via: 'statfs',
      };
    }
    const [k, i] = await Promise.all([
      safeExec('df', ['-kP', measured], timeoutMs),
      safeExec('df', ['-iP', measured], timeoutMs),
    ]);
    if (k.timedOut) throw new Error('ran out of time');
    const space = k.code === 0 ? parseDfK(k.stdout) : null;
    if (!space) throw new Error('could not read the disk space');
    const ino = i.code === 0 && !i.timedOut ? parseDfI(i.stdout) : null;
    const has = !!(ino && ino.inodesTotal);
    return {
      totalBytes: space.totalBytes, availBytes: space.availBytes, availPct: pct(space.availBytes, space.totalBytes),
      inodesTotal: has ? ino.inodesTotal : null,
      inodesFree: has ? ino.inodesFree : null,
      inodesFreePct: has ? pct(ino.inodesFree, ino.inodesTotal) : null,
      via: 'df',
    };
  }

  async function disk(paths, { timeoutMs = 10000 } = {}) {
    const filesystems = [];
    const errors = [];
    const groups = new Map(); // dev -> { measured, items: [{label,path}] }
    for (const item of paths || []) {
      try {
        const loc = await locate(item.path, timeoutMs);
        const g = groups.get(loc.dev);
        if (g) g.items.push(item);
        else groups.set(loc.dev, { measured: loc.measured, items: [item] });
      } catch (e) {
        errors.push({ label: item.label, path: item.path, error: String((e && e.message) || e) });
      }
    }
    for (const g of groups.values()) {
      try {
        const m = await measureOne(g.measured, timeoutMs);
        const labels = g.items.map((x) => x.label).sort();
        filesystems.push({ key: labels.join('+'), labels, paths: g.items.map((x) => x.path), ...m });
      } catch (e) {
        for (const x of g.items) errors.push({ label: x.label, path: x.path, error: String((e && e.message) || e) });
      }
    }
    return { filesystems, errors };
  }

  async function folderSizes(folders, { timeoutMs = 60000 } = {}) {
    const out = [];
    for (const f of folders || []) {
      try { await stat(f.path); } catch { continue; } // missing: skipped
      const r = await safeExec('du', ['-sk', f.path], timeoutMs);
      const kb = r.timedOut ? null : num((r.stdout.trim().split(/\s+/)[0]));
      if (kb === null) {
        out.push({ label: f.label, path: f.path, bytes: null, error: r.timedOut ? 'ran out of time' : (r.stderr.trim().split('\n')[0] || 'could not measure the folder') });
      } else {
        out.push({ label: f.label, path: f.path, bytes: kb * 1024 });
      }
    }
    out.sort((a, b) => (a.bytes === null) - (b.bytes === null) || (b.bytes || 0) - (a.bytes || 0));
    return out;
  }

  function osFallback(via = 'os') {
    return { totalBytes: os.totalmem(), availableBytes: os.freemem(), swapTotalBytes: null, swapUsedBytes: null, via };
  }

  async function memory() {
    try {
      if (platform === 'linux') {
        const m = parseMeminfo(await readFile('/proc/meminfo', 'utf8'));
        if (m.totalBytes === null || m.availableBytes === null) return osFallback();
        const swapOk = m.swapTotalBytes !== null && m.swapFreeBytes !== null;
        return {
          totalBytes: m.totalBytes, availableBytes: m.availableBytes,
          swapTotalBytes: swapOk ? m.swapTotalBytes : null,
          swapUsedBytes: swapOk ? Math.max(0, m.swapTotalBytes - m.swapFreeBytes) : null,
          via: 'proc',
        };
      }
      if (platform === 'darwin') {
        const v = await safeExec('vm_stat', [], 10000);
        const vm = v.code === 0 && !v.timedOut ? parseVmStat(v.stdout) : null;
        if (!vm) return osFallback();
        const s = await safeExec('sysctl', ['-n', 'vm.swapusage'], 10000);
        const swap = s.code === 0 && !s.timedOut ? parseSwapUsage(s.stdout) : null;
        return {
          totalBytes: os.totalmem(), availableBytes: Math.min(vm.availableBytes, os.totalmem()),
          swapTotalBytes: swap ? swap.totalBytes : null,
          swapUsedBytes: swap ? swap.usedBytes : null,
          via: 'vm_stat',
        };
      }
    } catch { /* fall through */ }
    return osFallback();
  }

  async function clock() {
    if (platform === 'linux') {
      const r = await safeExec('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], 10000);
      const v = r.stdout.trim().toLowerCase();
      if (r.code === 0 && !r.timedOut && (v === 'yes' || v === 'no')) return { synced: v === 'yes', how: 'timedatectl' };
      return { synced: null, how: 'timedatectl' };
    }
    if (platform === 'darwin') {
      const r = await safeExec('systemsetup', ['-getusingnetworktime'], 10000);
      const m = /Network Time:\s*(On|Off)/i.exec(r.stdout);
      if (r.code === 0 && !r.timedOut && m) return { synced: m[1].toLowerCase() === 'on', how: 'systemsetup' };
      return { synced: null, how: 'systemsetup' };
    }
    return { synced: null, how: 'unsupported' };
  }

  async function sizeOf(file) {
    try { return (await stat(file)).size; } catch { return null; }
  }

  async function dbCheck(file, { timeoutMs = 60000 } = {}) {
    const bytes = await sizeOf(file);
    const r = await safeExec(nodePath, [path.join(__dirname, 'db-check.js'), file], timeoutMs);
    if (r.timedOut) return { ok: null, result: 'ran out of time', bytes };
    const line = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop();
    try {
      const j = JSON.parse(line);
      if (j && (j.ok === true || j.ok === false || j.ok === null)) return { ok: j.ok, result: String(j.result === undefined ? '' : j.result), bytes };
    } catch { /* fall through */ }
    return { ok: null, result: (r.stderr.trim().split('\n')[0]) || 'could not read the check result', bytes };
  }

  async function fileSizes(files) {
    const out = [];
    for (const p of files || []) out.push({ path: p, bytes: await sizeOf(p) });
    return out;
  }

  const osUpdates = createOsUpdates({ platform, safeExec, exists, stat, readFile });

  return { disk, folderSizes, memory, clock, dbCheck, fileSizes, osUpdates };
}

module.exports = { createProbes, parseDfK, parseDfI, parseMeminfo, parseVmStat, parseSwapUsage };
