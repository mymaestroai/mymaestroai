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
 *   mymaestro connect chatgpt        use your ChatGPT subscription: installs Codex and signs it in (--device-auth: sign in with a code)
 *   mymaestro connect claude         sign Claude in on this computer (its own sign-in: a link, then paste the code) and check it answers
 *   mymaestro codex-check [--repair] is Codex where this install needs it? --repair reinstalls it (the installer runs this)
 *   mymaestro update [--channel stable|experimental] [--put-aside]   newest version of the channel, then restart (the Update button); --put-aside: first put changed files aside (git stash, never put back)
 *   mymaestro doctor                 security and setup checks (scripts/security-check.js)
 *   mymaestro backup [--to <dir>]    an encrypted backup of everything that makes this install yours (--setup: choose the backup password)
 *   mymaestro backups                list the backups on this computer and in your backup folders
 *   mymaestro restore <file|latest>  put a backup back: its password, what changes, then RESTORE (--recovery-key; --undo: the setup before)
 *   mymaestro reset-2fa <email>      turn off two-factor for an account (lost phone); it is set up again at next sign-in
 *   mymaestro reset-password <email>   set a new password for an account (forgotten password); asks for it twice, hidden
 *   mymaestro service install|remove start by itself at boot (Linux) or login (Mac)
 *   mymaestro move-home [--yes]      move shared folders (share/, users/...) out of your home folder into the install; --yes does it
 *   mymaestro face install <folder|owl> [--id <slug>]   add a character pack (the voice call face) from a folder, or download one (owl)
 *   mymaestro face list              the installed character packs
 *   mymaestro face remove <id> [--yes]   move a pack to <hub home>/faces-removed (never deleted; restore with face install)
 *   mymaestro team                   the starter team (Challenger, Scout, Builder, Researcher): which are set up; read-only
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
// Everything this command writes to settings, agents or preferences is journaled as "cli" (lib/settings-journal, the same journal
// file as the running hub's). After each write the store leaves a marker with the file's new stamp, so the running hub, which sees
// the file change, does not journal the same change again as an outside edit.
try { require(path.join(__dirname, '..', 'lib', 'settings-journal')).enterActor({ kind: 'cli', why: `command line: ${String(cmd).replace(/[^\w-]/g, '').slice(0, 30)}` }); } catch { /* an older install without the journal */ }
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

// Reads one line from the terminal without echoing it: raw mode, Enter ends, Backspace edits, Ctrl-C restores the terminal and exits 130.
// The typed characters are never written anywhere. Only for a real terminal (the caller checks); tests inject their own reader.
// Raw mode goes on BEFORE the prompt is printed and stays on between prompts (so nothing typed ahead is echoed); endHidden() puts the terminal
// back. SIGTERM, SIGHUP, SIGINT, SIGQUIT and a normal exit all restore it.
let hiddenSignals = null;
function endHidden() {
  try { process.stdin.setRawMode(false); } catch { /* not a terminal any more */ }
  try { process.stdin.pause(); } catch { /* closed */ }
  if (!hiddenSignals) return;
  process.removeListener('exit', endHidden);
  for (const [sig, h] of hiddenSignals) process.removeListener(sig, h);
  hiddenSignals = null;
}
function beginHidden() {
  if (hiddenSignals) return;
  const stop = (code) => () => { endHidden(); process.stdout.write('\n'); process.exit(code); };
  hiddenSignals = [['SIGTERM', stop(143)], ['SIGHUP', stop(129)], ['SIGINT', stop(130)], ['SIGQUIT', stop(131)]];
  for (const [sig, h] of hiddenSignals) process.on(sig, h);
  process.on('exit', endHidden);
  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode(true);
}
function readHidden(q) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let chars = [];
    beginHidden();
    function onData(chunk) {
      // Arrow keys and other escape sequences arrive as one chunk starting with ESC: they are not part of the password.
      const text = String(chunk).replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b[@-~]?/g, '');
      for (const ch of Array.from(text)) {
        if (ch === '\r' || ch === '\n') { stdin.removeListener('data', onData); try { stdin.pause(); } catch { /* closed */ } process.stdout.write('\n'); resolve(chars.join('')); return; }
        if (ch === '\u0003') { endHidden(); process.stdout.write('\n'); process.exit(130); }
        if (ch === '\u001c') { endHidden(); process.stdout.write('\n'); process.exit(131); }   // Ctrl-\ (quit)
        if (ch === '\u007f' || ch === '\b') { chars.pop(); continue; }
        if (ch === '\t' || ch >= ' ') chars.push(ch);   // a tab is part of the password
      }
    }
    process.stdout.write(q);
    stdin.resume();
    stdin.on('data', onData);
  });
}

// The refusal line for a person running as root (sudo) on an install whose data folder belongs to someone else: root would leave
// root-owned files (users.json, auth.db-wal, auth.db-shm) the hub cannot use. Null when there is nothing to refuse.
function rootOwnerNote({ getuid = process.getuid ? process.getuid.bind(process) : null, stat = fs.statSync, dataDir = path.join(DIR, 'data') } = {}) {
  if (typeof getuid !== 'function' || getuid() !== 0) return null;
  let st; try { st = stat(dataDir); } catch { return null; }
  if (st.uid === 0) return null;
  return `Run this without sudo, as the user that runs your Maestro (user id ${st.uid}).`;
}

// While the terminal is in the hidden (raw) mode and nobody is reading yet, Ctrl-C is only a typed character. This watches for it
// (and Ctrl-\) and calls onCtrlC; everything else typed is kept and handed back to the next reader when the returned release() runs.
function watchCtrlC(onCtrlC, { keepInput = true } = {}) {
  const stdin = process.stdin;
  const kept = [];
  const onData = (chunk) => {
    const text = String(chunk);
    if (text.includes('\u0003') || text.includes('\u001c')) {
      onCtrlC();
      return;
    }
    if (keepInput) kept.push(text);
  };
  stdin.on('data', onData);
  stdin.resume();
  return () => {
    stdin.removeListener('data', onData);
    try { stdin.pause(); } catch { /* closed */ }
    const text = kept.join('');
    kept.length = 0;
    if (text) { try { stdin.unshift(text); } catch { /* closed */ } }
  };
}
const realHidden = { begin: beginHidden, end: endHidden, watch: watchCtrlC };

// The default check of `connect claude`: a check turn through the real client (it reaches the network). Refused under node --test.
function defaultCheck({ signal } = {}) {
  require(path.join(DIR, 'lib', 'claude-signin-guard')).guardProgram();
  return require(path.join(DIR, 'lib', 'welcome')).getWelcome().checkClaude({
    timeoutMs: 90000, signal, probeOnly: true
  });
}

// `mymaestro connect claude`: signs the Claude client in on this computer through the same engine as the page
// (lib/claude-signin.js): the engine runs the client's `auth login --claudeai` with its output captured, this command prints the
// link, reads the code with the hidden reader (readHidden: echo off, never written anywhere, never on a command line) and hands
// it to the engine, then proves Claude answers. Returns the exit code (0 = done, 1 = failed, 130 = Ctrl-C).
// The code is read from a terminal only: sudo, then a stdin that is not a terminal, are refused FIRST, before the client is found or
// installed or anything else with a side effect. Nothing in this command changes behaviour from an environment variable of its own.
// Right after the refusals the terminal goes into the hidden mode (raw, no echo) and stays there until the code is read and the
// command ends (done, failed, Ctrl-C, exception), so nothing typed ahead is ever echoed.
// The config folder is the install's, not the terminal's: the install's .env CLAUDE_CONFIG_DIR wins; without one the terminal's is dropped.
// Never prints or logs a code or token. Injectable for tests: say, sayErr, rootNote, env, signin, verify, read, isTTY, envFile, pollMs,
// platform, hidden ({begin, end, watch}), exit.
async function connectClaude({ say = out, sayErr = (s) => process.stderr.write(s + '\n'), rootNote = rootOwnerNote, env: env0 = process.env, signin = null, verify = null, read = null, isTTY = !!process.stdin.isTTY, envFile = path.join(DIR, '.env'), pollMs = 200, platform = process.platform, hidden = null, exit = (c) => process.exit(c) } = {}) {
  const refuse = rootNote(); if (refuse) { sayErr(refuse); return 1; }   // the sign-in must belong to the user that runs the hub
  if (!isTTY) { sayErr('connect claude asks for the code in a terminal; run it in a terminal on the computer that runs your Maestro.'); return 1; }
  const hid = hidden || (read ? { begin() {}, end() {}, watch: null } : realHidden);   // an injected reader never touches the real terminal
  let engine = null, attempt = null, release = null, ended = false;
  const stopEngine = () => { try { if (engine) engine.cancel(attempt); } catch { /* nothing running */ } };
  const endTerminal = () => { if (ended) return; ended = true; if (release) { try { release(); } catch { /* closed */ } release = null; } try { hid.end(); } catch { /* not a terminal any more */ } };
  const cliAbort = new AbortController();
  const onSignal = () => {
    cliAbort.abort();
    stopEngine();
    endTerminal();
    say('');
    exit(130);
  };
  process.on('exit', stopEngine);   // Ctrl-C in raw mode ends the process from readHidden: the client is stopped here
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    hid.begin();   // no echo from here on
    if (hid.watch) release = hid.watch(onSignal);   // Ctrl-C is a typed character in this mode: watch for it until the reader takes over
    const si = signin || require(path.join(DIR, 'lib', 'claude-signin'));
    const W = si.WORDS;
    const cliDone =
      'Signed in. Claude answered using this installation\'s CLI settings. ' +
      'If your Maestro service uses a custom account or Claude folder, ' +
      'use Sign in again on its page to check that service. Otherwise, send your message again.';
    const env = { ...env0 };
    const fileDir = typeof si.configDirFromEnvFile === 'function' ? si.configDirFromEnvFile(envFile) : null;
    const termDir = env.CLAUDE_CONFIG_DIR || null;
    if (fileDir) {
      if (termDir && termDir !== fileDir) say(`Using the Claude folder your Maestro uses: ${fileDir} (this terminal's CLAUDE_CONFIG_DIR is not used).`);
      env.CLAUDE_CONFIG_DIR = fileDir;
      if (env0 === process.env) process.env.CLAUDE_CONFIG_DIR = fileDir;   // the check turn (welcome.checkClaude) reads process.env: same folder as the sign-in
    } else if (termDir) {
      say("Using the default Claude folder, as your Maestro does (this terminal's CLAUDE_CONFIG_DIR is not used).");
      delete env.CLAUDE_CONFIG_DIR;
      if (env0 === process.env) delete process.env.CLAUDE_CONFIG_DIR;
    }
    const check = verify || defaultCheck;
    const macSsh = platform === 'darwin' && !!env0.SSH_CONNECTION;
    const fail = (line) => {
      sayErr(line);
      if (macSsh) sayErr("Over SSH a Mac's keychain can be locked. Run this in Terminal on the Mac itself, or press Sign in again on your Maestro's page.");
      return 1;
    };
    const find = () => si.findClient({ env });
    const found = find();
    const cenv = si.clientEnv(env);

    if (found) {
      const status = await si.authStatus({
        bin: found.bin, env: cenv, signal: cliAbort.signal
      });
      if (cliAbort.signal.aborted) return 130;
      if (status.loggedIn === true) {
        say(W.checking);
        let v;
        try { v = await check({ signal: cliAbort.signal }); }
        catch { v = { ok: false, state: 'error' }; }
        if (cliAbort.signal.aborted) return 130;
        if (v && v.ok) { say(cliDone); return 0; }
        const reason = si.reasonFromVerify(v);
        if (reason !== 'account') return fail(W.failed[reason] || W.failed.error);
        // signed in for the client, but the login does not work (expired): sign in once more, then the check decides
      }
    }

    // A missing client is installed by the engine itself (its findClient returns null), under its cancellation.
    engine = si.createSignIn({
      env: () => cenv,
      findClient: find,
      existingClient: typeof si.existingClient === 'function' ? () => si.existingClient() : undefined,   // the same "usable client" rule as the page's engine
      verify: check
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const failedLine = (st) => (st && st.message) || W.failed.error;
    say(W.signedOut);
    const started = await engine.start({ signal: cliAbort.signal });
    if (cliAbort.signal.aborted) return 130;
    if (!started || !started.ok) return fail(W.failed[started && started.reason] || W.failed.error);
    attempt = started.id;
    let st = engine.state();
    let saidInstalling = false;
    while (st.state === 'starting' || st.state === 'installing') {   // the engine's own timeout ends this
      if (st.state === 'installing' && !saidInstalling) { say('Claude Code is not on this computer. Installing it…'); saidInstalling = true; }
      await sleep(pollMs); st = engine.state();
    }
    if (st.state !== 'link') return fail(failedLine(st));
    say(W.openLink);
    say('  ' + st.link);
    say('Paste the code below and press Enter. It is not shown as you paste it.');
    const rd = read || readHidden;
    if (release) { release(); release = null; }   // the reader takes over; what was typed ahead goes to it
    let submitted = false;
    for (let tries = 0; tries < 3 && !submitted; tries++) {
      let code = await rd('> ');
      const res = engine.submitCode(code, attempt);
      code = null;   // the code is not kept
      if (res.ok) { submitted = true; break; }
      if (res.reason === 'format') { say("That doesn't look like the whole code. Copy all of it and paste it again."); continue; }
      return fail(failedLine(engine.state()));
    }
    if (!submitted) { engine.cancel(attempt); return fail('Too many tries. The sign-in was stopped.'); }
    // The code reader is done: Ctrl-C is a typed character again, so watch for it while the check runs. Nothing typed is kept.
    if (hid.watch) release = hid.watch(onSignal, { keepInput: false });
    let saidChecking = false;
    st = engine.state();
    while (st.state === 'link' || st.state === 'checking') {
      if (st.state === 'checking' && !saidChecking) { say(W.checking); saidChecking = true; }
      await sleep(pollMs);
      st = engine.state();
    }
    if (st.state === 'done') { if (!saidChecking) say(W.checking); say(cliDone); return 0; }
    return fail(failedLine(st));
  } finally {
    process.removeListener('exit', stopEngine);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    endTerminal();   // the terminal is back to normal
    stopEngine();
  }
}

// `mymaestro reset-password <email>`: returns the exit code (0 = the password was set). `readHidden` can be injected for tests.
async function resetPassword(login, { a = null, read = readHidden, interactive = !!(process.stdin.isTTY && process.stdout.isTTY), say = out, sayErr = (s) => process.stderr.write(s + '\n'), policy = null, rootNote = rootOwnerNote } = {}) {
  if (!login) { sayErr('Usage: mymaestro reset-password <email>'); return 1; }
  const refuse = rootNote(); if (refuse) { sayErr(refuse); return 1; }   // before anything is opened or read
  if (!interactive) { sayErr('reset-password asks for the new password in a terminal; run it in a terminal on the computer that runs your Maestro.'); return 1; }
  a = a || auth();
  const check = policy || require(path.join(DIR, 'lib', 'auth')).passwordPolicy;
  const u = a.findByLogin(login);
  if (!u) { sayErr(`No account "${login}".`); return 1; }
  let pw = null;
  try {
    for (let tries = 0; tries < 3 && pw === null; tries++) {
      const first = await read('New password: ');
      const problem = check(first);
      if (problem) { say(problem); continue; }
      const second = await read('Type it again: ');
      if (first !== second) { say('The two passwords are not the same. Try again.'); continue; }
      pw = first;
    }
  } finally { endHidden(); }   // the terminal is back to normal before anything else is said
  if (pw === null) { sayErr('Too many tries. The password was not changed.'); return 1; }
  let r;
  try { r = a.setPassword(u.id, pw, { by: 'cli' }); } catch (e) { sayErr(e.message); return 1; }   // e.g. users.json cannot be read: nothing was saved
  if (!r.ok) { sayErr(r.error); return 1; }
  a.clearFailures(u.login);
  say(`Password set for ${u.login}. Every other sign-in of this account was signed out. Sign in with the new password; if the phone with two-factor is lost too, run: mymaestro reset-2fa ${u.login}`);
  if (u.disabled) say('This account is turned off; an admin can turn it back on on the Users page (account menu → Users → Enable).');
  return 0;
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
// Folders where a `codex` link may sit: the one the installer put the mymaestro command in, and ~/.local/bin.
function binDirsForCodex() {
  const dirs = [path.join(os.homedir(), '.local', 'bin')];
  try { const b = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'install.json'), 'utf8')).bin; if (b) dirs.unshift(path.dirname(b)); } catch { /* not installed by the installer */ }
  return [...new Set(dirs)];
}
// The installer's own Node.js folder (data/install.json): a codex link into it was left by an npm -g there.
function nodeDirsForCodex() {
  try { const d = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'install.json'), 'utf8')).nodeDir; return d ? [d] : []; } catch { return []; }
}
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
  // Installs Codex into ~/.npm-global with this install's own npm (lib/codex-cli/setup: outside the Node.js folder the
  // installer replaces), where the hub looks for it, then runs Codex's own sign-in in this terminal. The hub never sees
  // the sign-in.
  async connect() {
    if (argv[1] === 'claude') {
      require(path.join(DIR, 'lib', 'claude-signin-guard')).allowRealEffects();   // the command run by a person: the one place besides server.js
      process.exitCode = await connectClaude();
      return;
    }
    if (argv[1] !== 'chatgpt') fail('Usage: mymaestro connect chatgpt [--device-auth]\n       mymaestro connect claude');
    const codex = require(path.join(DIR, 'lib', 'codex-cli'));
    const setup = require(path.join(DIR, 'lib', 'codex-cli', 'setup'));
    const env = codex.withNode(process.env);
    let bin = codex.resolveBinary(env);
    if (!bin) {
      out('Installing Codex, the OpenAI program that connects to your ChatGPT subscription…');
      bin = setup.installCodex({ env: process.env }).bin;
      if (!bin) fail('Codex did not install. Check the internet connection and run this again.');
      setup.repairLinks({ env: process.env, binDirs: binDirsForCodex(), nodeDirs: nodeDirsForCodex() });
    }
    const before = await codex.loginStatus({ bin, env });
    if (before.loggedIn && before.mode === 'chatgpt') {
      out('Codex is already signed in to ChatGPT.');
    } else {
      // No desktop here (an SSH session, a server): the browser sign-in has nothing to open, so sign in with a code.
      const noDesktop = !!process.env.SSH_CONNECTION || (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
      const code = flag('--device-auth') || noDesktop;
      out(code ? 'Signing in: Codex shows a link and a code. Open the link in a browser on any device.\nIf it says that isn\'t allowed, turn on device code sign-in under Security in your ChatGPT settings, then run this again.\n' : 'Signing in: Codex opens ChatGPT in your browser.\n');
      spawnSync(bin, code ? ['login', '--device-auth'] : ['login'], { stdio: 'inherit', env });
      const after = await codex.loginStatus({ bin, env });
      if (!(after.loggedIn && after.mode === 'chatgpt')) fail('\nThe sign-in did not finish. Run this again when you are ready.');
    }
    out(`\nDone. Back in ${PRODUCT}, press Check on the setup page, or in Settings under AI models.`);
  },
  // After the installer replaced its Node.js (or any time): is Codex where this install needs it? --repair repoints a
  // dangling codex link and reinstalls Codex into ~/.npm-global. Exit 1 when it is needed and still missing. --quiet
  // (the installer): say something only when a link was repointed, Codex was reinstalled, or it is still missing.
  'codex-check'() {
    const setup = require(path.join(DIR, 'lib', 'codex-cli', 'setup'));
    const quiet = flag('--quiet');
    if (flag('--repair') && !quiet) out('Checking Codex…');
    const r = setup.checkCodex({ env: process.env, dataDir: path.join(DIR, 'data'), binDirs: binDirsForCodex(), nodeDirs: nodeDirsForCodex(), repair: flag('--repair') });
    for (const l of r.relinked) out(`Codex link ${l} now points at ${path.join(setup.codexPrefix(), 'bin', 'codex')}.`);
    if (r.installed) out(`Codex reinstalled in ${setup.codexPrefix()}.`);
    if (!r.needed) { if (!quiet) out(r.bin ? `Codex: ${r.bin}` : 'Codex: not used by this install.'); return; }
    if (r.bin) { if (!quiet) out(`Codex: ${r.bin}`); return; }
    // only a ChatGPT sign-in folder (the Codex desktop app or an editor extension make one): a hint, not a fault
    if (!r.inUse) { if (!quiet) out(`Codex (the ChatGPT client) is not installed. To let your agents use your ChatGPT plan: ${r.fix}`); return; }
    out(`Codex is not installed, and this install uses it (an agent on ChatGPT). Fix: ${r.fix}`);
    process.exitCode = 1;
  },
  async update() {
    const gs = require(path.join(DIR, 'lib', 'git-sync'));
    const channel = arg('channel');
    if (channel && !['stable', 'experimental'].includes(channel)) fail('Channel is "stable" or "experimental".');
    out('Checking for a newer version…');
    const putAside = flag('--put-aside');
    const r = putAside ? await gs.runPutAsideUpdate({ channel }) : await gs.runUpdate({ channel });
    if (!r.success) {
      out(r.error || 'Update failed.');
      // Changed files of the code itself: nothing moves the code over them. Say which, and how to put them aside.
      if (Array.isArray(r.localChanges) && r.localChanges.length) {
        for (const file of r.localChanges.slice(0, 20)) out(`  ${file}`);
        if (r.localChanges.length > 20) out(`  (and ${r.localChanges.length - 20} more)`);
        out('Run `mymaestro update --put-aside` to put them aside and update.');
      }
      process.exitCode = /up to date/i.test(r.error || '') ? 0 : 1;
      return;
    }
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
    // Codex (the ChatGPT client), when this install uses it: found, or the one command that brings it back.
    try {
      const cx = require(path.join(DIR, 'lib', 'codex-cli', 'setup')).checkCodex({ env: process.env, dataDir: path.join(DIR, 'data'), binDirs: binDirsForCodex(), nodeDirs: nodeDirsForCodex() });
      if (cx.needed) out(cx.bin ? `\nCodex (ChatGPT): ${cx.bin}` : cx.inUse ? `\nCodex (ChatGPT): not installed, and an agent uses it. Fix: ${cx.fix}` : `\nCodex (ChatGPT): not installed (only needed for agents on your ChatGPT plan: ${cx.fix}).`);
    } catch { /* no module */ }
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
      out('\nYour recovery key opens every backup, even without My Maestro (with the free "age" tool). You can show it again any time in Settings → Backups → Show recovery key (it asks for the backup password):\n');
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
    const refuse = rootOwnerNote(); if (refuse) fail(refuse);   // before auth.db is opened or users.json read
    const a = auth(); const u = a.findByLogin(login); if (!u) fail(`No account "${login}".`);
    let r; try { r = a.totpDisable(u.id, { by: 'cli' }); } catch (e) { fail(e.message); }   // e.g. users.json cannot be read: nothing was saved
    if (!r.ok) fail(r.error);
    out(`Two-factor is off for ${u.login}. Sign in with the password, then set up two-factor again (account menu → Security).`);
  },
  async 'reset-password'() {
    const code = await resetPassword(argv[1]);
    if (code) process.exit(code);
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
  // Character packs for the voice call face (lib/faces): install from a local folder into <hub home>/faces/<id>, or list them.
  async face() {
    const sub = argv[1];
    const { HUB_HOME } = require(path.join(DIR, 'lib', 'hub-home'));
    const faces = require(path.join(DIR, 'lib', 'faces', 'packs'));
    if (sub === 'install') {
      const folder = argv[2] && !argv[2].startsWith('--') ? argv[2] : null;
      if (!folder) fail('Usage: mymaestro face install <folder|owl> [--id <slug>]');
      if (!fs.existsSync(folder) && require(path.join(DIR, 'lib', 'faces', 'catalog')).catalogEntry(folder)) {
        if (arg('id')) fail('--id is only for installing from a folder.');
        const download = require(path.join(DIR, 'lib', 'faces', 'download'));
        const entry = require(path.join(DIR, 'lib', 'faces', 'catalog')).catalogEntry(folder);
        const mb = (n) => Math.round(n / 1000000);
        let st = download.startDownload(entry.id, { home: HUB_HOME });
        if (st.state === 'busy') fail(st.error);
        if (st.state === 'done') { out(`The character pack "${entry.id}" is already installed.`); return; }
        let lastLine = 0, shownInstalling = false;
        while (st.state === 'downloading' || st.state === 'installing') {
          const now = Date.now();
          if (st.state === 'downloading' && now - lastLine >= 1000) {
            lastLine = now;
            out(`Downloading the ${entry.name.toLowerCase()}\u2026 ${Math.floor(st.received * 100 / st.total)}% \u00b7 ${mb(st.received)} of ${mb(st.total)} MB`);
          } else if (st.state === 'installing' && !shownInstalling) {
            shownInstalling = true;
            out(`Downloading the ${entry.name.toLowerCase()}\u2026 100% \u00b7 ${mb(st.total)} of ${mb(st.total)} MB`);
            out('Installing\u2026');
          }
          await new Promise(res => setTimeout(res, 250));
          st = download.downloadStatus(entry.id, { home: HUB_HOME });
        }
        if (st.state !== 'done') fail(`Could not install: ${st.error || 'the download failed'}`);
        if (!shownInstalling) { out(`Downloading the ${entry.name.toLowerCase()}\u2026 100% \u00b7 ${mb(st.total)} of ${mb(st.total)} MB`); out('Installing\u2026'); }
        const pack = faces.getPack(entry.id, { home: HUB_HOME });
        const total = pack ? Object.values(pack.files).reduce((a, f) => a + f.size, 0) : st.total;
        out(`Installed the character pack "${entry.id}" (${pack ? Object.keys(pack.files).length : '?'} files, ${(total / 1000000).toFixed(1)} MB) in ${path.join(HUB_HOME, 'faces', entry.id)}.`);
        out('Choose it per device in the voice panel, or as an agent\'s default on the agent settings page.');
        return;
      }
      try {
        const r = faces.installPack(folder, { home: HUB_HOME, id: arg('id') || undefined });
        out(`Installed the character pack "${r.id}" (${r.files.length} files, ${(r.total / 1048576).toFixed(1)} MB) in ${r.dir}.`);
        out('Choose it per device in the voice panel, or as an agent\'s default on the agent settings page.');
      } catch (e) { fail(`Could not install: ${e.message}`); }
      return;
    }
    if (sub === 'list') {
      const list = faces.listPacks({ home: HUB_HOME });
      if (!list.length) { out('No character packs are installed. Add one: mymaestro face install <folder|owl>'); return; }
      for (const p of list) out(`${p.id}  ${p.manifest.name || p.id}  ${p.manifest.clips.length} clips`);
      return;
    }
    // Remove = ONE rename into <hub home>/faces-removed/<id>-<timestamp>; nothing is deleted, and restoring is an install.
    if (sub === 'remove') {
      const id = argv[2] && !argv[2].startsWith('--') ? argv[2] : null;
      if (!id) fail('Usage: mymaestro face remove <id> [--yes]');
      let plan;
      try { plan = faces.removePack(id, { home: HUB_HOME, dryRun: true }); } catch (e) { fail(`Could not remove: ${e.message}`); }
      out(`The character pack "${id}" moves out of use:\n  ${plan.from}\n  -> ${plan.to}`);
      out('Nothing is deleted. It stops being listed or served at once; the hub does not need a restart.');
      if (!flag('--yes')) {
        const answer = await new Promise((resolve) => {
          const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
          rl.on('close', () => resolve(''));   // closed input (nothing piped in) counts as "no"
          rl.question('Move it? Type y to confirm: ', (a) => { resolve(a); rl.close(); });
        });
        if (!/^(y|yes)$/i.test(String(answer).trim())) { process.stdin.destroy(); fail('Nothing was changed.'); }
        process.stdin.destroy();
      }
      try {
        const r = faces.removePack(id, { home: HUB_HOME });
        out(`Moved the character pack "${r.id}" to ${r.to}`);
        out(`To bring it back:  ${r.restore}`);
      } catch (e) { fail(`Could not remove: ${e.message}`); }
      return;
    }
    fail('Usage: mymaestro face install <folder|owl> [--id <slug>]\n       mymaestro face list\n       mymaestro face remove <id> [--yes]');
  },
  async uninstall() {
    const m = svc(); const inst = m.readInstall();
    m.remove(); out('Service removed.');
    if (inst.bin && fs.existsSync(inst.bin) && fs.readFileSync(inst.bin, 'utf8').includes(path.join(DIR, 'scripts', 'hub-cli.js'))) { fs.unlinkSync(inst.bin); out(`Removed ${inst.bin}`); }
    if (inst.stateDir && inst.nodeDir && inst.nodeDir.startsWith(inst.stateDir) && fs.existsSync(inst.nodeDir)) { fs.rmSync(inst.nodeDir, { recursive: true, force: true }); out(`Removed the private Node at ${inst.nodeDir}`); }
    out(`\nYour data and the program are still in ${DIR}.`);
    out(`To delete everything, back up first (mymaestro backup), then run:  rm -rf "${DIR}"`);
  },
  // Read-only: creation happens only in the running hub, which owns the ledger (data/team.json).
  team() {
    const data = path.join(DIR, 'data');
    const st = require(path.join(DIR, 'lib', 'starter-team'));
    const ledger = st.readLedger(path.join(data, 'team.json'));
    let agents = [];
    try { const a = JSON.parse(fs.readFileSync(path.join(data, 'agents.json'), 'utf8')); if (Array.isArray(a)) agents = a; } catch { /* no agents list yet */ }
    let unfinished = false;
    try { const p = JSON.parse(fs.readFileSync(path.join(data, 'welcome.json'), 'utf8')) || {}; unfinished = !!p.startedAt && !p.finishedAt; } catch { /* no setup record */ }
    out('Your starter team:');
    if (ledger.unreadable) {
      out('  The team ledger (data/team.json) could not be read, so nothing is created while it is unreadable. Fix or restore that file first.');
      return;
    }
    let missing = 0;
    for (const r of st.ROLES) {
      const had = ledger.roles[r.role];
      const find = (name) => agents.find(a => a && a.name === name);
      let line;
      if (had) {
        const a = find(had.name);
        if (a) line = `created (agent ${a.name}, model ${a.model || 'not set'})`;
        else if (had.status === 'reserved') line = 'stopped halfway (interrupted)';
        else line = 'set up earlier, since removed or renamed';
      } else if (find(r.name) || agents.some(a => a && String(a.display || '').toLowerCase() === r.display.toLowerCase())) line = 'name taken by your own agent';
      else line = 'not set up';
      if (line === 'not set up') missing++;
      out(`  ${r.display}: ${line}`);
    }
    if (ledger.skippedAt) out(`  (You chose to skip the team on ${ledger.skippedAt}.)`);
    if (!missing) return;   // nothing the hub could still set up
    out('');
    out(unfinished ? `To create the missing ones, open ${URL_BASE}/welcome on this computer.` : `To add them, open ${URL_BASE}/?team=setup on this computer and choose Set up your team.`);
  },
  version() { const { v, commit, channel } = version(); out(`${PRODUCT} ${v} (${commit}, ${channel} channel)`); },
  // The help is the comment block at the top of this file: lines 4 to 28 (one more than before `connect claude` was listed).
  help() { out(fs.readFileSync(__filename, 'utf8').split('\n').slice(3, 28).map(l => l.replace(/^ \* ?/, '')).join('\n')); },
};

module.exports = { resetPassword, connectClaude, defaultCheck, readHidden, endHidden, rootOwnerNote };   // for tests: the command's logic with an injectable password reader

if (require.main === module) (async () => {
  const fn = commands[cmd] || (cmd === '--help' || cmd === '-h' ? commands.help : null);
  if (!fn) { out(`Unknown command "${cmd}".\n`); commands.help(); process.exit(2); }
  await fn();
})().catch(e => fail(`Error: ${e.message}`));
