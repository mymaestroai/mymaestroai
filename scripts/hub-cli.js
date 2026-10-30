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
 *   mymaestro backup [--to <dir>]    an encrypted backup of everything that makes this install yours (--setup: choose the backup password)
 *   mymaestro backups                list the backups on this computer and in your backup folders
 *   mymaestro restore <file|latest>  put a backup back: its password, what changes, then RESTORE (--recovery-key; --undo: the setup before)
 *   mymaestro reset-2fa <email>      turn off two-factor for an account (lost phone); it is set up again at next sign-in
 *   mymaestro service install|remove start by itself at boot (Linux) or login (Mac)
 *   mymaestro move-home [--yes]      move shared folders (share/, users/...) out of your home folder into the install; --yes does it
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

// A password prompt that doesn't echo what is typed.
function askHidden(q) {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (str) => { if (str.includes(q)) process.stdout.write(q); };
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

function ask(q) {
  return new Promise((resolve) => { const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); resolve(a); }); });
}
// What a prepared restore changes, in plain lines (the same facts as the warning in Settings → Backups).
function restoreWarning(r) {
  const b = r.backup || {}, rep = r.report || {}, s = r.summary;
  const when = b.created ? new Date(b.created).toLocaleString() : 'an unknown date';
  const lines = [`The backup is from ${when}: My Maestro AI ${b.version || '?'}, ${b.counts ? b.counts.files : '?'} files${b.label ? ` (${b.label})` : ''}.`];
  if (b.working && b.working.length) lines.push(`Agents were working when it was made: ${b.working.join(', ')}. Their last steps may be missing.`);
  if (s) {
    if (s.messages) lines.push(`${s.messages} chat messages written since then are lost (${s.chatAgents.join(', ')}).`);
    if (s.agentsAdded.length) lines.push(`Agents created since then go away: ${s.agentsAdded.join(', ')}.`);
    if (s.agentsBack.length) lines.push(`Agents deleted since then come back: ${s.agentsBack.join(', ')}.`);
    if (s.newerFiles) lines.push(`${s.newerFiles}${s.newerFilesCapped ? '+' : ''} files in workspaces and shared folders changed since then; they go back to the backup's copies.`);
    if (s.jobs) lines.push(`${s.jobs} background jobs ran since then; their records go away.`);
  }
  if (rep.accounts && rep.accounts.disabled && rep.accounts.disabled.length) lines.push(`Accounts only in the backup come back turned off: ${rep.accounts.disabled.join(', ')}.`);
  if (rep.accounts && rep.accounts.kept && rep.accounts.kept.length) lines.push('Accounts keep today\'s passwords, two-factor and sign-ins, and API tokens you revoked stay revoked. Provider keys, connected accounts and other settings go back to the backup\'s.');
  if (r.summary && rep.keyStatus === 'replaced') lines.push('This backup was made with a backup key this install has replaced (perhaps because its password leaked). Restore it only if you made it yourself.');
  if (r.summary && rep.keyStatus === 'other') lines.push('This backup was made with a different backup key than this install\'s (another computer, or a setup from before). Restore it only if you made it yourself.');
  if (rep.linksDropped && rep.linksDropped.length) lines.push(`${rep.linksDropped.length} links pointed outside the backup and are left out.`);
  if (rep.skipped && rep.skipped.length) lines.push(`${rep.skipped.length} files were left out of this backup when it was made (changing, unreadable, or leading outside their folder).`);
  if (rep.unsettled && rep.unsettled.length) lines.push(`${rep.unsettled.length} files were changing while the backup was made; they may be a little older.`);
  lines.push('After the restore, agents and schedules wait until you press Resume (Settings → Backups); tasks that came due wait for Run or Skip.');
  lines.push('Today\'s setup is kept for 7 days: mymaestro restore --undo puts it back.');
  return lines;
}
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
  // Backups (lib/backup): encrypted with the backup key from Settings → Backups; --setup chooses the backup password here.
  async backup() {
    const keys = require(path.join(DIR, 'lib', 'backup', 'keys'));
    const placesMod = require(path.join(DIR, 'lib', 'backup', 'places'));
    const { HUB_HOME } = require(path.join(DIR, 'lib', 'hub-home'));
    if (flag('--setup')) {
      if (await up()) fail('Stop My Maestro first (mymaestro stop), or choose the backup password in Settings → Backups while it runs.');
      const before = keys.status();
      if (before.configured && !flag('--replace')) fail('Backups are already set up. Change the password in Settings → Backups. If both the password and the recovery key are lost: mymaestro backup --setup --replace');
      out('Choose a backup password: at least 12 characters; a few random words work well. It is never stored.');
      const pw = await askHidden('Backup password: ');
      try { keys.checkPassword(pw); } catch (e) { fail(e.message); }
      if (await askHidden('Again: ') !== pw) fail('The two passwords differ; nothing was changed.');
      const r = await keys.setup(pw);
      if (before.configured) {   // the old key's backups can't be opened by the new key: list it as retiring
        const st = require(path.join(DIR, 'lib', 'settings')); const b = st.get().backup || {};
        st.updateSettings({ backup: { ...b, retiring: (b.retiring || []).filter(x => x && x.keyId !== before.keyId).concat([{ keyId: before.keyId, since: new Date().toISOString(), lost: true }]) } });
      }
      out('\nYour recovery key opens every backup, even without My Maestro (with the free "age" tool). It is shown only now:\n');
      out(`  ${r.recoveryKey}\n`);
      out('Print it or keep it in a password manager. If you lose both the password and the recovery key, nobody can open the backups.');
      return;
    }
    if (!keys.status().configured) fail('Backups aren\'t set up yet. Choose a backup password in Settings → Backups, or run:  mymaestro backup --setup');
    const conf = (require(path.join(DIR, 'lib', 'settings')).get().backup) || {};
    const targets = [placesMod.localPlace(HUB_HOME), ...(conf.folders || []).filter(f => f && f.dir && f.enabled !== false).map(f => placesMod.folderPlace(f.dir))];
    if (arg('to')) targets.push(placesMod.folderPlace(arg('to')));
    const { v, commit, channel } = version();
    out((await up()) ? 'Backing up while the hub runs (files that change meanwhile are named in the backup)…' : 'Backing up…');
    const r = await require(path.join(DIR, 'lib', 'backup', 'create')).createBackup({ root: DIR, hubHome: HUB_HOME, reason: 'cli', hub: { version: v, commit, channel }, places: targets });
    for (const p of r.places) out(p.error ? `  not saved in ${p.dir}: ${p.error}` : `  ${p.file}`);
    out(`Backup written: ${(r.size / 1048576).toFixed(1)} MB, ${r.manifest.counts.files} files, ${r.manifest.label}.`);
  },
  async backups() {
    const placesMod = require(path.join(DIR, 'lib', 'backup', 'places'));
    const { HUB_HOME } = require(path.join(DIR, 'lib', 'hub-home'));
    const conf = (require(path.join(DIR, 'lib', 'settings')).get().backup) || {};
    const list = await placesMod.list(DIR, [placesMod.localPlace(HUB_HOME), ...(conf.folders || []).filter(f => f && f.dir).map(f => placesMod.folderPlace(f.dir))]);
    if (!list.length) { out('No backups found. Make one: mymaestro backup'); return; }
    for (const b of list) out(`${b.created ? new Date(b.created).toLocaleString() : '?'}  ${b.size != null ? (b.size / 1048576).toFixed(1) + ' MB' : '?'}  ${b.version || '?'}  ${b.places.map(p => p.file).join(', ')}`);
  },
  // Restore while the hub is stopped: open and check, show what changes, then the swap happens when it starts again.
  async restore() {
    const restoreMod = require(path.join(DIR, 'lib', 'backup', 'restore'));
    const applyMod = require(path.join(DIR, 'lib', 'backup', 'apply'));
    const placesMod = require(path.join(DIR, 'lib', 'backup', 'places'));
    const { HUB_HOME } = require(path.join(DIR, 'lib', 'hub-home'));
    if (await up()) fail('Stop My Maestro first (mymaestro stop), then run this again. Or restore from Settings → Backups while it runs.');
    if (flag('--undo')) {
      const last = applyMod.lastRestore({ root: DIR });
      if (!last || !last.canUndo) fail('There is no restore to undo here (the setup from before a restore is kept for 7 days).');
      out(`This puts back the setup from before the restore of ${new Date(last.createdAt || last.healthyAt).toLocaleString()}. What was done since the restore goes away.`);
      if (!flag('--yes') && (await ask('Type UNDO to put it back: ')).trim() !== 'UNDO') fail('Nothing was changed.');
      applyMod.confirmUndo({ root: DIR });
      out('Confirmed: the setup from before comes back when My Maestro starts.');
    } else {
      const target = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
      if (!target) fail('Usage: mymaestro restore <backup file | latest> [--recovery-key] [--yes]\n       mymaestro restore --undo');
      let file = target;
      if (target === 'latest') {
        const conf = (require(path.join(DIR, 'lib', 'settings')).get().backup) || {};
        const list = await placesMod.list(DIR, [placesMod.localPlace(HUB_HOME), ...(conf.folders || []).filter(f => f && f.dir).map(f => placesMod.folderPlace(f.dir))]);
        if (!list.length) fail('No backups found on this computer or in your backup folders.');
        file = list[0].places[0].file;
      }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`No such backup file: ${file}`);
      const useKey = flag('--recovery-key');
      const secret = await askHidden(useKey ? 'Recovery key (AGE-SECRET-KEY-1…): ' : 'Backup password: ');
      let users = []; try { users = auth().listUsers(); } catch { /* none yet */ }
      out(`Opening and checking ${file} …`);
      let r;
      try { r = await restoreMod.prepare({ file, ...(useKey ? { recoveryKey: secret.trim() } : { password: secret }), root: DIR, hubHome: HUB_HOME, mode: users.length ? 'existing' : 'fresh', hubVersion: version().v }); }
      catch (e) { fail(e.message); }
      out('\nThe backup is good. Restoring it replaces this install:');
      for (const l of restoreWarning(r)) out(`  - ${l}`);
      const forget = () => { const d = restoreMod.restoreDirs(DIR); fs.rmSync(d.staged, { recursive: true, force: true }); fs.rmSync(d.prepared, { force: true }); };
      if (!flag('--yes') && (await ask('\nType RESTORE to replace this install with the backup: ')).trim() !== 'RESTORE') { forget(); fail('Nothing was changed.'); }
      applyMod.confirm({ root: DIR, hubHome: HUB_HOME, id: r.id });
      out('Confirmed: the backup replaces this install when My Maestro starts.');
    }
    process.stdin.destroy();   // no more questions: with a piped stdin the prompts would otherwise keep the process open
    if (flag('--no-start')) { out('Start it when you are ready: mymaestro start'); return; }
    const s = svc().start(); if (!s.ok) fail(`Could not start it: ${s.error}. Start it with: mymaestro start`);
    out('Starting…');
    out((await waitUp(90)) ? `Running at ${URL_BASE}. Agents wait until you press Resume in Settings → Backups.` : 'It did not answer within 90 seconds. See: mymaestro logs');
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
  // Older installs made by the installer keep share/, users/ (and granted medical/, legal/) loose in the home folder:
  // move them into <install>/hub-home (lib/hub-home moveHome). Without --yes it only shows what would move.
  async 'move-home'() {
    const { moveHome } = require(path.join(DIR, 'lib', 'hub-home'));
    const plan = moveHome({ root: DIR });
    if (!plan.ok) fail(plan.error);
    if (!plan.plan.length) { for (const n of plan.notes) out(n); return; }
    out(`These folders move from your home folder into ${plan.target}:`);
    for (const s of plan.plan) out(`  ${s.from}  ->  ${s.to}`);
    out('A link stays at each old place, so paths your agents wrote down keep working.');
    if (!argv.includes('--yes')) { out('\nNothing has been moved yet. To move them (the hub stops and starts again): mymaestro move-home --yes'); return; }
    const wasRunning = await up();
    if (wasRunning) {
      out('Stopping the hub...');
      const r = await svc().stop();
      if (!r.ok) fail(`Could not stop it (${r.error || 'unknown error'}); nothing was moved.`);
      for (let i = 0; i < 30 && await up(); i++) await new Promise(res => setTimeout(res, 1000));
      if (await up()) fail('The hub still answers, so nothing was moved. Stop it (mymaestro stop) and try again.');
    }
    const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    let r;
    try { r = moveHome({ root: DIR, apply: true, docker }); }
    catch (e) { r = { ok: false, partial: true, error: `Moving stopped unexpectedly (${e.message}). Check ${path.join(DIR, 'hub-home')} and your home folder before starting the hub.`, notes: [] }; }
    if (r.ok) out(`Moved ${r.done.map(s => s.name).join(', ')} into ${r.target}.`);
    else out(r.error);
    for (const n of r.notes) out(n);
    // Start it again when the move worked or was cleanly undone; never on a half-moved layout.
    if (wasRunning && !r.partial) {
      out('Starting the hub...');
      const s = svc().start(); if (!s.ok) fail(`Could not start it: ${s.error}`);
      out((await waitUp(60)) ? `Running at ${URL_BASE}` : 'It did not answer within a minute. See: mymaestro logs');
    } else if (wasRunning) out('The hub stays stopped until the folders above are back in place; then: mymaestro start');
    if (!r.ok) process.exitCode = 1;
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
  help() { out(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 20).map(l => l.replace(/^ \* ?/, '')).join('\n')); },
};

(async () => {
  const fn = commands[cmd] || (cmd === '--help' || cmd === '-h' ? commands.help : null);
  if (!fn) { out(`Unknown command "${cmd}".\n`); commands.help(); process.exit(2); }
  await fn();
})().catch(e => fail(`Error: ${e.message}`));
