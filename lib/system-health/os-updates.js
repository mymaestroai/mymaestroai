'use strict';
// Operating-system update probe for the health check (read-only: never installs, never refreshes the lists, never uses sudo).

const APT_CHECK = '/usr/lib/update-notifier/apt-check';
const APT_STAMP = '/var/lib/apt/periodic/update-success-stamp';
const APT_LISTS = '/var/lib/apt/lists';
const REBOOT = '/var/run/reboot-required';

const empty = (kind = null) => ({ kind, pending: null, security: null, critical: null, listsRefreshedAt: null, restartRequired: null, restartPkgs: [], error: null });
const absent = (r) => r.code === null && !r.timedOut;   // could not even start: the program isn't there
const why = (r, what) => (r.timedOut ? `${what} ran out of time` : `${what} failed${r.code === null ? '' : ` (exit ${r.code})`}`);

function parseAptCheck(text) {
  const m = /(\d+);(\d+)/.exec(String(text || ''));
  return m ? { pending: Number(m[1]), security: Number(m[2]) } : null;
}

function parseAptSimulate(text) {
  let pending = 0, security = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line.startsWith('Inst ')) continue;
    pending++;
    const m = /\(([^)]*)\)/.exec(line);
    if (m && /-security/.test(m[1])) security++;
  }
  return { pending, security };
}

// dnf check-update: package lines have 3 whitespace columns; "Obsoleting Packages" ends the list.
function parseDnfList(text) {
  let n = 0;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^Obsoleting/i.test(line)) break;
    if (line.split(/\s+/).length === 3) n++;
  }
  return n;
}

function parseZypper(text) {
  let security = 0, critical = 0;
  for (const raw of String(text || '').split('\n')) {
    if (!/\|\s*security\s*\|/.test(raw)) continue;
    security++;
    const cells = raw.split('|').map((c) => c.trim().toLowerCase());
    const i = cells.indexOf('security');
    if (cells[i + 1] === 'critical') critical++;
  }
  return { security, critical };
}

// "* Label: macOS Sonoma 14.5-23F79" then "\tTitle: macOS Sonoma 14.5, Version: 14.5, Size: 6869472KiB, Recommended: YES, Action: restart,"
function parseSoftwareUpdate(text) {
  const items = [];
  for (const line of String(text || '').split('\n')) {
    if (/^\s*\*\s+(Label:\s*)?\S/.test(line)) items.push({ recommended: false, restart: false });
    else if (items.length && /(Title|Recommended|Action):/.test(line)) {
      const it = items[items.length - 1];
      if (/Recommended:\s*YES/i.test(line)) it.recommended = true;
      if (/Action:\s*restart/i.test(line)) it.restart = true;
    }
  }
  return items;
}

function createOsUpdates({ platform, safeExec, exists, stat, readFile }) {
  async function mtime(p) {
    try { const s = await stat(p); const t = s && (s.mtimeMs !== undefined ? s.mtimeMs : s.mtime && s.mtime.getTime()); return Number.isFinite(t) ? t : null; } catch { return null; }
  }

  async function apt(out, timeoutMs, haveCheck, pre) {
    out.kind = 'apt';
    if (haveCheck) {
      const r = await safeExec(APT_CHECK, [], timeoutMs);
      const p = r.timedOut ? null : parseAptCheck(`${r.stderr}\n${r.stdout}`);
      if (p) Object.assign(out, p); else out.error = why(r, 'The update check');
    } else {
      const r = pre || await safeExec('apt-get', ['-s', 'upgrade'], timeoutMs, { LC_ALL: 'C' });
      if (r.code === 0 && !r.timedOut) Object.assign(out, parseAptSimulate(r.stdout)); else out.error = why(r, 'The update check');
    }
    out.listsRefreshedAt = (await mtime(APT_STAMP)) ?? (await mtime(APT_LISTS));
    if (await exists(REBOOT)) {
      out.restartRequired = true;
      try {
        const lines = String(await readFile(`${REBOOT}.pkgs`, 'utf8')).split('\n').map((l) => l.trim()).filter(Boolean);
        out.restartPkgs = [...new Set(lines)].slice(0, 20);
      } catch { /* the list is optional */ }
    } else out.restartRequired = false;
  }

  async function needsRestarting() {
    const r = await safeExec('needs-restarting', ['-r'], 30000);
    if (r.timedOut || r.code === null) return null;
    return r.code === 1 ? true : r.code === 0 ? false : null;
  }

  async function dnf(out, timeoutMs, first) {
    out.kind = 'dnf';
    if (first.code === 100) out.security = parseDnfList(first.stdout);
    else if (first.code === 0) out.security = 0;
    else out.error = why(first, 'The security update check');
    const all = await safeExec('dnf', ['-C', '-q', 'check-update'], timeoutMs);
    if (all.code === 100) out.pending = parseDnfList(all.stdout);
    else if (all.code === 0) out.pending = 0;
    else out.error = out.error || why(all, 'The update check');
    const c = await safeExec('dnf', ['-C', '-q', 'updateinfo', 'list', '--security', '--sec-severity=Critical'], timeoutMs);
    out.critical = c.code === 0 && !c.timedOut ? c.stdout.split('\n').filter((l) => l.trim()).length : null;
    out.restartRequired = await needsRestarting();
  }

  async function zypper(out, r) {
    out.kind = 'zypper';
    if (r.code === 0 && !r.timedOut) {
      const z = parseZypper(r.stdout);
      out.security = z.security; out.critical = z.critical; out.pending = z.security;
    } else out.error = why(r, 'The update check');
    out.restartRequired = await needsRestarting();
  }

  async function darwin(out, timeoutMs) {
    out.kind = 'softwareupdate';
    const r = await safeExec('softwareupdate', ['-l'], timeoutMs);
    if (r.timedOut || r.code !== 0) { out.error = why(r, 'The update check'); return; }
    const text = `${r.stdout}\n${r.stderr}`;
    const items = /No new software available/i.test(text) ? [] : parseSoftwareUpdate(text);
    out.pending = items.length;
    out.security = items.filter((i) => i.recommended).length;
    out.restartRequired = items.some((i) => i.restart);
  }

  return async function osUpdates({ timeoutMs = 120000 } = {}) {
    const out = empty();
    try {
      if (platform === 'darwin') { await darwin(out, timeoutMs); return out; }
      if (platform !== 'linux') { out.error = 'no package manager it recognises'; return out; }
      if (await exists(APT_CHECK)) { await apt(out, timeoutMs, true); return out; }
      const a = await safeExec('apt-get', ['-s', 'upgrade'], timeoutMs, { LC_ALL: 'C' });
      if (!absent(a)) { await apt(out, timeoutMs, false, a); return out; }
      const d = await safeExec('dnf', ['-C', '-q', 'check-update', '--security'], timeoutMs);
      if (!absent(d)) { await dnf(out, timeoutMs, d); return out; }
      const z = await safeExec('zypper', ['--non-interactive', '--no-refresh', 'lp', '-g', 'security'], timeoutMs);
      if (!absent(z)) { await zypper(out, z); return out; }
      out.error = 'no package manager it recognises';
    } catch (e) {
      out.error = String((e && e.message) || e);
    }
    return out;
  };
}

module.exports = { createOsUpdates, parseAptCheck, parseAptSimulate, parseDnfList, parseZypper, parseSoftwareUpdate };
