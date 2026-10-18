#!/usr/bin/env node
'use strict';
// Security check from a terminal: no hub process, no agent. It reads the same files and asks the same tools as the
// Settings page box (lib/security-check) and never prints a secret.
//
//   node scripts/security-check.js               plain-text report
//   node scripts/security-check.js --json        the same as JSON (what GET /api/security-check returns)
//   node scripts/security-check.js --fix-modes   tighten the file permissions it flags, then report
//
// Exit code: 2 when something is critical, 1 when there are only warnings, 0 when clean (3 on an error), so a cron
// line or a shell script can act on it.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// .env the way the server reads it, without overriding what the shell already set.
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
} catch {}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write('usage: node scripts/security-check.js [--json] [--fix-modes]\n');
  process.exit(0);
}

// Hub modules log a line or two when they load; keep stdout for the report only (so --json is parseable).
const toStderr = (...a) => process.stderr.write(a.map(x => (typeof x === 'string' ? x : String(x))).join(' ') + '\n');
console.log = toStderr; console.info = toStderr; console.warn = toStderr;
const { createSecurityCheck, defaultDeps, renderText } = require('../lib/security-check');

(async () => {
  const deps = defaultDeps();
  // Exposure the way the server decides it at start (lib/bind-host): HOST in .env, accounts, two-factor.
  try {
    const { resolveBindHost } = require('../lib/bind-host');
    const b = resolveBindHost(process.env, {
      hasUsers: deps.hasUsers,
      hasSecuredAdmin: () => deps.listUsers().some(u => u.role === 'admin' && !u.disabled && u.totpEnabled),
    });
    deps.exposed = () => !!b.exposed;
    deps.host = b.host;
  } catch {}
  deps.port = parseInt(process.env.PORT || '8888', 10);
  deps.log = () => {};
  const sc = createSecurityCheck(deps);

  if (args.includes('--fix-modes')) {
    const r = sc.fixModes();
    if (!args.includes('--json')) {
      process.stdout.write((r.fixed.length ? `Tightened: ${r.fixed.map(f => `${f.path} ${f.from} → ${f.to}`).join(', ')}` : 'Nothing to tighten.') + '\n');
      for (const f of r.failed) process.stdout.write(`Could not change ${f.path}: ${f.error}\n`);
    }
  }
  const r = await sc.check();
  process.stdout.write((args.includes('--json') ? JSON.stringify(r, null, 2) : renderText(r)) + '\n');
  process.exit(r.critical ? 2 : r.warnings ? 1 : 0);
})().catch(e => { console.error(`security-check: ${e.message}`); process.exit(3); });
