#!/usr/bin/env node
'use strict';
/**
 * mymaestro — look after My Maestro AI from a terminal. Works while the hub is stopped.
 *
 *   mymaestro status                 running?, address, version, channel, service, setup link while no account exists
 *   mymaestro start | stop | restart
 *   mymaestro logs [-f] [-n 100]     the server log (follow with -f)
 *   mymaestro open                   open it in the browser, or print the address
 *   mymaestro setup-link             the first-run Welcome link (until the first account exists)
 *   mymaestro update [--channel stable|experimental]   newest version of the channel, then restart (the Update button)
 *   mymaestro doctor                 security and setup checks (scripts/security-check.js)
 *   mymaestro backup [--to <dir>]    data, settings, agents and their memory, in one archive
 *   mymaestro reset-2fa <email>      turn off two-factor for an account (lost phone); it is set up again at next sign-in
 *   mymaestro service install|remove start by itself at boot (Linux) or login (Mac)
 *   mymaestro uninstall              remove the service, this command and the private Node; keeps the folder and data
 *   mymaestro version
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');

const DIR = path.join(__dirname, '..');
const PRODUCT = 'My Maestro AI';
const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const arg = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i > 0 && i + 1 < argv.length ? argv[i + 1] : dflt; };
const flag = (...names) => names.some(n => argv.includes(n));
const svc = () => require(path.join(DIR, 'lib', 'service-manager')).createServiceManager({ dir: DIR });
const out = (s = '') => process.stdout.write(s + '\n');
const fail = (s, code = 1) => { process.stderr.write(s + '\n'); process.exit(code); };

function envPort() {
  try {
    const m = fs.readFileSync(path.join(DIR, '.env'), 'utf8').match(/^\s*PORT\s*=\s*(\d+)/m);
    if (m) return Number(m[1]);
  } catch { /* no .env */ }
  return Number(svc().readInstall().port || process.env.PORT || 8888);
}
const PORT = envPort();
const URL_BASE = `http://localhost:${PORT}`;

async function up(timeoutMs = 2500) {
  for (const p of ['/health', '/api/health']) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { signal: ctrl.signal }); clearTimeout(t);
      if (r.status) return true;
    } catch { /* not answering */ }
  }
  return false;
}
async function waitUp(seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) { if (await up(1500)) return true; await new Promise(r => setTimeout(r, 500)); }
  return false;
}
function git(args) { try { return execFileSync('git', args, { cwd: DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } }
function version() {
  const v = require(path.join(DIR, 'package.json')).version;
  const commit = git(['rev-parse', '--short', 'HEAD']);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const channel = branch === 'main' ? 'stable' : branch === 'dev' ? 'experimental' : branch || 'unknown';
  return { v, commit, branch, channel };
}
function auth() { return require(path.join(DIR, 'lib', 'auth')).createAuth({ log: () => {}, dataDir: path.join(DIR, 'data') }); }
function setupLink() {
  if (auth().hasUsers()) return null;
  const code = require(path.join(DIR, 'lib', 'welcome')).createWelcome({ dataDir: path.join(DIR, 'data') }).ensureSetupToken();
  return `${URL_BASE}/welcome?token=${code}`;
}
function openUrl(url) {
  const opener = process.platform === 'darwin' ? 'open' : (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) ? 'xdg-open' : null;
  if (!opener) return false;
  try { spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref(); return true; } catch { return false; }
}

const commands = {
  async status() {
    const { v, commit, channel } = version();
    const s = svc().state();
    const running = await up();
    out(`${PRODUCT} ${v} (${commit || 'no git'}, ${channel} channel)`);
    out(`  Folder:   ${DIR}`);
    out(`  Address:  ${URL_BASE}  ${running ? '(running)' : '(not answering)'}`);
    out(`  Service:  ${s.kind === 'none' ? 'none (started by hand; "mymaestro service install" makes it start by itself)' : `${s.kind} ${s.unit || s.label}: ${s.status}${s.enabled ? ', starts by itself' : ''}`}`);
    let users = null; try { users = auth().listUsers(); } catch { /* unreadable */ }
    if (users) out(`  Accounts: ${users.length ? `${users.filter(u => u.role === 'admin').length} admin, ${users.filter(u => u.role !== 'admin').length} member` : 'none yet'}`);
    const link = users && !users.length ? setupLink() : null;
    if (link) out(`\nFinish setting up: ${link}`);
    if (!running) process.exitCode = 3;
  },
  async start() {
    const r = svc().start(); if (!r.ok) fail(`Could not start: ${r.error}`);
    out(r.already ? 'Already running.' : 'Starting…');
    out((await waitUp(60)) ? `Running at ${URL_BASE}` : 'It did not answer within a minute. See: mymaestro logs');
  },
  async stop() { const r = await svc().stop(); if (!r.ok) fail(`Could not stop: ${r.error || 'unknown error'}`); out(r.already ? 'It was not running.' : 'Stopped.'); },
  async restart() {
    const r = await svc().restart(); if (!r.ok) fail(`Could not restart: ${r.error}`);
    out('Restarting…'); await new Promise(res => setTimeout(res, 2000));
    out((await waitUp(60)) ? `Running at ${URL_BASE}` : 'It did not answer within a minute. See: mymaestro logs');
  },
  logs() {
    const i = argv.findIndex(a => a === '-n' || a === '--lines');
    const n = String(Number(i > 0 ? argv[i + 1] : 100) || 100);
    const file = path.join(DIR, 'server.log');
    const s = svc().detect();
    if (!fs.existsSync(file) && s.kind === 'systemd') {
      const a = ['--user', '-u', s.unit, '-n', n, '--no-pager']; if (flag('-f', '--follow')) a.push('-f');
      return spawnSync('journalctl', a, { stdio: 'inherit' });
    }
    if (!fs.existsSync(file)) fail('No server.log yet.');
    spawnSync('tail', ['-n', n, ...(flag('-f', '--follow') ? ['-f'] : []), file], { stdio: 'inherit' });
  },
  open() {
    const link = setupLink();
    const url = link || URL_BASE;
    if (!openUrl(url)) out(`Open this in your browser: ${url}`);
    else out(`Opening ${url}`);
  },
  'setup-link'() {
    const link = setupLink();
    if (flag('--plain')) { if (link) out(link); return; }   // for the installer: just the link, or nothing once an account exists
    out(link ? `Open this link to finish setting up ${PRODUCT}:\n\n  ${link}\n\nIt works until the first account is created.` : `Setup is done: an account exists. Sign in at ${URL_BASE}/login`);
  },
  async update() {
    const gs = require(path.join(DIR, 'lib', 'git-sync'));
    const channel = arg('channel');
    if (channel && !['stable', 'experimental'].includes(channel)) fail('Channel is "stable" or "experimental".');
    out('Checking for a newer version…');
    const r = await gs.runUpdate({ channel });
    if (!r.success) { out(r.error || 'Update failed.'); process.exitCode = /up to date/i.test(r.error || '') ? 0 : 1; return; }
    for (const step of r.steps || []) out(`  ${step}`);
    await commands.restart();
  },
  async doctor() {
    const { v, commit, channel } = version();
    out(`${PRODUCT} ${v} (${commit}, ${channel}) on Node ${process.versions.node}, ${process.platform}/${process.arch}`);
    const s = svc().state(); out(`Service: ${s.kind} ${s.status}`);
    out(`Answering: ${(await up()) ? 'yes' : 'no'} (${URL_BASE})\n`);
    const r = spawnSync(process.execPath, [path.join(DIR, 'scripts', 'security-check.js')], { cwd: DIR, stdio: 'inherit' });
    process.exitCode = r.status || 0;
    // The Claude sign-in: proven with one tiny request through the same client the agents use (lib/welcome).
    let installed = false; try { installed = require(path.join(DIR, 'lib', 'claude-auth')).hasSdkCredentials(); } catch { /* no module */ }
    if (!installed) { out('\nClaude sign-in: not set up on this computer (only needed for Claude subscription models).'); return; }
    out('\nClaude sign-in: testing with a one-word question…');
    const c = await require(path.join(DIR, 'lib', 'welcome')).createWelcome({ dataDir: path.join(DIR, 'data') }).checkClaude({ timeoutMs: 90000 });
    out(c.ok ? 'Claude sign-in: working.' : `Claude sign-in: ${c.error}${c.state === 'signed-out' ? '\n  Fix: run "claude" in a terminal, sign in, then type /exit.' : ''}`);
  },
  backup() {
    const destDir = path.resolve(arg('to', path.join(os.homedir(), 'MyMaestroAI-backups')));
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mymaestro-backup-'));
    const stage = path.join(tmp, `my-maestro-ai-${stamp}`);
    fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
    const Database = require(path.join(DIR, 'node_modules', 'better-sqlite3'));
    const skip = (rel) => /^data\/(local-models\/(llama\.cpp|bin|models)|modules\/[^/]+\/pkg|jobs\/[^/]+\/out\.log)/.test(rel) || /-(wal|shm)$/.test(rel) || rel.endsWith('.sock');
    const pending = [];
    function copyTree(rel) {
      const src = path.join(DIR, rel); let st; try { st = fs.lstatSync(src); } catch { return; }
      if (skip(rel)) return;
      if (st.isSymbolicLink()) return;
      if (st.isDirectory()) { fs.mkdirSync(path.join(stage, rel), { recursive: true }); for (const f of fs.readdirSync(src)) copyTree(path.join(rel, f)); return; }
      if (/\.db$/.test(rel)) { pending.push(rel); return; }
      fs.copyFileSync(src, path.join(stage, rel));
    }
    for (const rel of ['data', 'workspaces', '.env']) copyTree(rel);
    return (async () => {
      for (const rel of pending) { const db = new Database(path.join(DIR, rel), { readonly: true, fileMustExist: true }); await db.backup(path.join(stage, rel)); db.close(); }
      fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
      const file = path.join(destDir, `my-maestro-ai-${stamp}.tar.gz`);
      execFileSync('tar', ['-czf', file, '-C', tmp, path.basename(stage)]);
      fs.chmodSync(file, 0o600);
      fs.rmSync(tmp, { recursive: true, force: true });
      out(`Backup written: ${file} (${(fs.statSync(file).size / 1048576).toFixed(1)} MB)`);
      out('To restore: mymaestro stop; unpack it over the program folder; mymaestro start.');
    })();
  },
  'reset-2fa'() {
    const login = argv[1]; if (!login) fail('Usage: mymaestro reset-2fa <email>');
    const a = auth(); const u = a.findByLogin(login); if (!u) fail(`No account "${login}".`);
    const r = a.totpDisable(u.id, { by: 'cli' }); if (!r.ok) fail(r.error);
    out(`Two-factor is off for ${u.login}. Sign in with the password, then set up two-factor again (Settings → Security).`);
  },
  service() {
    const sub = argv[1];
    if (sub === 'install') {
      const r = svc().install({ node: process.execPath });
      if (!r.ok) fail(r.error);
      out(`Service installed (${r.kind} ${r.unit || r.label}).`); for (const n of r.notes || []) out(`  ${n}`);
      return;
    }
    if (sub === 'remove') { const r = svc().remove(); out(r.removed.kind === 'none' ? 'There was no service.' : `Service removed (${r.removed.unit || r.removed.label}).`); return; }
    fail('Usage: mymaestro service install | remove');
  },
  async uninstall() {
    const m = svc(); const inst = m.readInstall();
    m.remove(); out('Service removed.');
    if (inst.bin && fs.existsSync(inst.bin) && fs.readFileSync(inst.bin, 'utf8').includes(path.join(DIR, 'scripts', 'hub-cli.js'))) { fs.unlinkSync(inst.bin); out(`Removed ${inst.bin}`); }
    if (inst.stateDir && inst.nodeDir && inst.nodeDir.startsWith(inst.stateDir) && fs.existsSync(inst.nodeDir)) { fs.rmSync(inst.nodeDir, { recursive: true, force: true }); out(`Removed the private Node at ${inst.nodeDir}`); }
    out(`\nYour data and the program are still in ${DIR}.`);
    out(`To delete everything, back up first (mymaestro backup), then run:  rm -rf "${DIR}"`);
  },
  version() { const { v, commit, channel } = version(); out(`${PRODUCT} ${v} (${commit}, ${channel} channel)`); },
  help() { out(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 18).map(l => l.replace(/^ \* ?/, '')).join('\n')); },
};

(async () => {
  const fn = commands[cmd] || (cmd === '--help' || cmd === '-h' ? commands.help : null);
  if (!fn) { out(`Unknown command "${cmd}".\n`); commands.help(); process.exit(2); }
  await fn();
})().catch(e => fail(`Error: ${e.message}`));
