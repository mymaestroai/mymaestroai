'use strict';
// The MeshCentral server this module runs: its config file, its first-start accounts, the process and its supervision.
// MeshCentral itself is read-only reference data: this file only builds a config, runs "node meshcentral.js ..." and waits for it.
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const VERSION = '1.3.1';
const GROUP_NAME = 'My Maestro computers';
const RESTART_DELAYS_MS = [5000, 30000, 120000, 600000];
const STABLE_MS = 10 * 60 * 1000;
const READY_MS = 90000;
const POLL_MS = 500;
const KILL_AFTER_MS = 10000;
const BOOT_KILL_AFTER_MS = 5000;
const ORPHAN_TERM_MS = 10000;
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
const BOOTSTRAP_TIMEOUT_MS = 120000;
const REPROBE_MS = 30000;
const DEFAULT_SERVICE_NAME = 'mymaestro-remote';
const SERVICE_NAME_RE = /^mymaestro-remote(-[a-z0-9]{1,16})?$/;
const SAFE_PATH_RE = /^\/[A-Za-z0-9._/-]+$/;   // what the root script (install.sh) accepts for a path
const NPM_GUARD = path.join(__dirname, 'no-npm.js');

// MeshCentral's own password hash (pass.js, MeshCentral 1.3.1), which is what a normal login compares against (webserver.js:923-925) and what
// `--createaccount <user> --hashpass <salt>,<hash>` / `--resetaccount <user> --hashpass <salt>,<hash>` store untouched (meshcentral.js:1049-1055, 1079-1085):
//   pass.js:14   len = 128                      (the derived key is 128 bytes)
//   pass.js:17   iterations = 12000
//   pass.js:39-41  salt = crypto.randomBytes(128).toString('base64')   (the salt is the base64 TEXT, not the raw bytes: pbkdf2 gets the string, i.e. its UTF-8 bytes)
//   pass.js:43   hash = crypto.pbkdf2(password, salt, 12000, 128, 'sha384').toString('base64')
// `--hashpass` is "<salt>,<hash>" (meshcentral.js:1051-1054); base64 never holds a comma, so the split is safe.
const PASS_ITERATIONS = 12000, PASS_LEN = 128, PASS_DIGEST = 'sha384';
function hashPassword(password, salt = crypto.randomBytes(PASS_LEN).toString('base64')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, PASS_ITERATIONS, PASS_LEN, PASS_DIGEST).toString('base64');
  return { salt, hash, arg: `${salt},${hash}` };
}

const DNS_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_RE = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;
const DEFAULT_ALLOWED = '100.64.0.0/10';
const ALLOWED_RE = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}(\/(3[0-2]|[12]?[0-9]))?$/;   // an IPv4 address or a CIDR range

const clean = (s, max = 300) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ').slice(0, max);

// Takes the secrets out of a text: the ones given, and anything that follows --pass / --hashpass (a command line quoted in an error message).
function redact(text, secrets = []) {
  let t = String(text == null ? '' : text);
  for (const sec of secrets) if (sec) t = t.split(sec).join('[secret]');
  return t.replace(/(--(?:hash)?pass(?:word)?(?:=|\s+))\S+/gi, '$1[secret]');
}

// Writes a private file atomically: a temp file in the same folder, then a rename.
function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch { /* already gone */ } throw e; }
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
}

const coded = (message, code) => Object.assign(new Error(message), { code });

// Does the control port answer a TLS handshake? (Loopback only; the certificate is not judged here, only that a server is listening.)
function tlsProbe(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { s.destroy(); } catch { /* closed */ } resolve(ok); };
    const s = tls.connect({ host, port, rejectUnauthorized: false, servername: 'localhost' }, () => finish(true));
    s.setTimeout(2000, () => finish(false));
    s.on('error', () => finish(false));
  });
}

function createMeshServer({ runtimeDir, home, settings, spawn = childProcess.spawn, execFile = childProcess.execFile, now = Date.now, log = () => {},
  probe = tlsProbe, timers = { setTimeout, clearTimeout }, npmGuard = NPM_GUARD, procRoot = '/proc', killPid = process.kill.bind(process), onRetryReady = null,
  mode = 'hub', serviceName = DEFAULT_SERVICE_NAME, moduleDir = '' } = {}) {
  if (!runtimeDir || !home) throw new Error('createMeshServer needs runtimeDir and home');
  const service = mode === 'service';
  if (service && !SERVICE_NAME_RE.test(String(serviceName))) throw new Error('The service name is not valid. Use mymaestro-remote, or mymaestro-remote- and up to 16 letters or digits.');
  const paths = {
    home,
    dataPath: path.join(home, 'meshcentral-data'),
    filesPath: path.join(home, 'meshcentral-files'),
    accountsFile: path.join(home, 'accounts.json'),
    pendingFile: path.join(home, 'accounts.pending.json'),   // an older version kept plaintext passwords here; it is only ever deleted now
    stateFile: path.join(home, 'state.json'),
    logFile: path.join(home, 'meshcentral.log'),
    pidFile: path.join(home, 'meshcentral.pid'),
    mainJs: path.join(runtimeDir, 'node_modules', 'meshcentral', 'meshcentral.js'),
  };
  paths.configFile = path.join(paths.dataPath, 'config.json');
  paths.rootCert = path.join(paths.dataPath, 'root-cert-public.crt');
  if (service) {
    // In service mode MeshCentral runs as its own system service; the hub only keeps a request for the root script and reads what the service shares back.
    paths.serviceDir = path.join(home, 'service');
    paths.rootCert = path.join(paths.serviceDir, 'root-cert-public.crt');
    paths.request = path.join(paths.serviceDir, 'request.env');
    paths.serviceConfig = path.join(paths.serviceDir, 'config.json');
    paths.installed = path.join(paths.serviceDir, 'installed.json');
  }
  const baseEnv = () => ({ PATH: process.env.PATH, HOME: home });

  // ── config ──
  // Every key below was read in MeshCentral 1.3.1 (config.json keys are lower-cased on load, meshcentral.js:4241 and common.js:147-157, at every depth; settings become args, meshcentral.js:187):
  //   cert (meshcentral.js:238), port/portBind (webserver.js:8386), agentPort/agentPortBind (webserver.js:8389; the .msh then carries agentPort, webserver.js:6388-6411,
  //   so no alias is set), redirPort 0 and mpsPort 0 (meshcentral.js:1686-1689: only null is replaced by a default), wanOnly (meshcentral.js:1910), exactPorts (webserver.js:9576),
  //   lockAgentDownload (webserver.js:6297,6381), userAllowedIp/agentAllowedIp (meshcentral.js:958-969), cookieIpCheck (meshcentral.js:985-987),
  //   agentDownloads {enabled, fetchReleases} (agentbuilds.js:395,229-230), autoBackup false (meshcentral.js:2211), filesPath (meshcentral.js:123), domain newAccounts (webserver.js:1784),
  //   domain passwordRequirements.logintokens false (meshuser.js:5363 and 5402: "Login tokens are not supported on this server"; read as domain.passwordrequirements after the lower-casing).
  function configFor(s = settings, opts = {}) {
    const forService = opts && opts.service !== undefined ? !!opts.service : service;
    const name = String((s && s.address_name) || '').trim().toLowerCase();
    if (!name) throw new Error('Waiting for setup: the tailnet name of this computer is not set.');
    if (!DNS_RE.test(name)) throw new Error('The tailnet name is not valid. Use a name such as hub.example.ts.net.');
    const ip = String((s && s.listen_ip) || '').trim();
    if (!ip) throw new Error('Waiting for setup: the tailnet address of this computer is not set.');
    if (!IPV4_RE.test(ip) || ip === '0.0.0.0') throw new Error('The tailnet address is not valid. Use the 100.x.y.z address Tailscale shows.');
    const port = Number(s.control_port === undefined ? 9971 : s.control_port), agentPort = Number(s.agent_port === undefined ? 9972 : s.agent_port);
    for (const [label, p] of [['control', port], ['computer', agentPort]]) {
      if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error(`The ${label} port must be a whole number from 1024 to 65535.`);
    }
    if (port === agentPort) throw new Error('The control port and the computer port must be different.');
    const rawAllowed = s.agent_allowed === undefined || s.agent_allowed === null || String(s.agent_allowed).trim() === '' ? DEFAULT_ALLOWED : String(s.agent_allowed);
    const parts = rawAllowed.split(',').map((x) => x.trim());
    if (parts.length > 32 || !parts.every((x) => ALLOWED_RE.test(x))) throw new Error('The allowed addresses are not valid. Use IPv4 addresses or ranges such as 100.64.0.0/10, separated by commas.');
    // Not "everything": 0.0.0.0 and a range wider than a /8 would let almost any address connect.
    if (parts.some((x) => x === '0.0.0.0' || x.startsWith('0.0.0.0/') || (x.includes('/') && Number(x.split('/')[1]) < 8))) throw new Error('The allowed addresses are too wide. Use a range of /8 or narrower, such as 100.64.0.0/10, and not 0.0.0.0.');
    const allowed = parts.join(',');
    return {
      settings: {
        cert: name,
        port,
        portBind: '127.0.0.1',
        agentPort,
        agentPortBind: ip,
        redirPort: 0,
        mpsPort: 0,
        wanOnly: true,
        exactPorts: true,
        newAccounts: false,
        lockAgentDownload: true,
        userAllowedIp: '127.0.0.1',
        agentAllowedIp: allowed,
        cookieIpCheck: 'strict',
        agentDownloads: { enabled: true, fetchReleases: false },
        autoBackup: false,
        filesPath: forService ? `/var/lib/${serviceName}/meshcentral-files` : paths.filesPath,
      },
      domains: { '': { title: 'My Maestro computers', newAccounts: false, passwordRequirements: { logintokens: false } } },
    };
  }

  function writeConfig(s = settings) {
    const cfg = configFor(s);
    for (const d of [paths.home, paths.dataPath, paths.filesPath]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    writeFileAtomic(paths.configFile, JSON.stringify(cfg, null, 2) + '\n');
    return cfg;
  }

  // ── the npm guard ──
  // MeshCentral checks its modules at every start and, for a missing one, runs `<npmpath> install ...` in a shell (meshcentral.js:4320-4322; the value of --npmpath
  // is read at :4393-4405). --npmpath is therefore a command line that always fails: this node running lib/no-npm.js. A missing module ends the start
  // with MeshCentral's own "Unable to install required modules" error and our message in the log, never a download.
  function npmGuardArgs() {
    const quote = (p) => {
      if (/["'$`\\\r\n;&|<>*?(){}!#~]/.test(p)) throw new Error('A folder name has characters that cannot be used in a command line.');
      return /\s/.test(p) ? `"${p}"` : p;
    };
    return ['--npmpath', `${quote(process.execPath)} ${quote(npmGuard)}`];
  }
  const baseArgs = () => [paths.mainJs, '--datapath', paths.dataPath, ...npmGuardArgs()];

  // ── life cycle ──
  // `epoch` goes up at every stop(); a bootstrap or a start that began before it ends with ECANCEL at its next step instead of going on.
  let epoch = 0;
  const cancelled = () => coded('Stopped.', 'ECANCEL');
  const sleep = (ms) => new Promise((r) => timers.setTimeout(r, ms));
  let child = null;       // the running MeshCentral process, if any
  const svc = { ready: false, reason: null, message: null, command: null, timer: null };   // service mode: the last probe of the system service
  const isRunning = () => (service ? svc.ready : !!child);
  let stopping = false, starting = null, restartTimer = null, stableTimer = null, exitWaiters = [];
  // A pause that stop() and a process exit cut short.
  const nap = (ms) => new Promise((resolve) => {
    const h = timers.setTimeout(resolve, ms);
    exitWaiters.push(() => { timers.clearTimeout(h); resolve(); });
  });

  // ── first-start accounts ──
  const bootProcs = new Set();   // { proc, done } for every account command that is running
  const runExec = (args) => {
    const entry = { proc: null, done: null };
    entry.done = new Promise((resolve) => {
      let settled = false;
      const finish = (err, stdout, stderr) => { if (settled) return; settled = true; bootProcs.delete(entry); resolve({ err, out: `${stdout || ''}${stderr ? `\n${stderr}` : ''}` }); };
      try {
        entry.proc = execFile(process.execPath, args, { cwd: runtimeDir, env: baseEnv(), timeout: BOOTSTRAP_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, finish) || null;
      } catch (e) { finish(e, '', ''); }
    });
    bootProcs.add(entry);
    return entry.done;
  };
  const tailLines = (text, secrets, n = 4) => redact(text, secrets).split(/\r?\n/).map((l) => clean(l, 200).trim()).filter(Boolean).slice(-n).join(' | ');

  // SIGTERM to every account command, SIGKILL after 5 s, and wait until they are gone.
  async function stopBootProcs() {
    const list = [...bootProcs];
    if (!list.length) return;
    for (const b of list) { try { if (b.proc && b.proc.kill) b.proc.kill('SIGTERM'); } catch { /* gone */ } }
    const all = Promise.all(list.map((b) => b.done));
    let killer;
    const late = new Promise((r) => { killer = timers.setTimeout(() => { for (const b of list) { try { if (b.proc && b.proc.kill) b.proc.kill('SIGKILL'); } catch { /* gone */ } } r('kill'); }, BOOT_KILL_AFTER_MS); });
    const first = await Promise.race([all.then(() => 'done'), late]);
    timers.clearTimeout(killer);
    if (first === 'kill') await Promise.race([all, sleep(2000)]);
  }

  // accounts.json: missing (ENOENT) is the one case that means "not made yet". Any other trouble stops the start with a clear message.
  function readAccountsStrict() {
    let a;
    try { a = readJsonFile(paths.accountsFile); } catch (e) {
      throw new Error(`The server accounts file could not be read (${clean((e && (e.code || e.name)) || 'error', 40)}). Nothing was changed. Check the file in the connector's data folder, or move it away to make new accounts.`);
    }
    if (a === null) return null;
    const ok = (x) => x && typeof x === 'object' && typeof x.user === 'string' && x.user && typeof x.pass === 'string' && x.pass;
    if (!a || typeof a !== 'object' || !ok(a.admin) || !ok(a.agent)) {
      throw new Error('The server accounts file is not in the form this connector wrote. Nothing was changed. Check the file in the connector\'s data folder, or move it away to make new accounts.');
    }
    return a;
  }

  // Creates the accounts while the server is stopped (MeshCentral writes straight to its database and exits: meshcentral.js:1038-1112).
  // Every attempt makes fresh passwords. No password is ever on a command line: the accounts are made with --hashpass <salt>,<hash> (see hashPassword).
  // An account that exists already (an earlier attempt) is reset with --resetaccount --hashpass (meshcentral.js:1069-1099: it accepts --hashpass, at :1079-1085,
  // and also unlocks the account and removes its 2FA) so that the new password is the one that works. accounts.json is written last, only when every step worked.
  //
  // Service mode: the credentials are made here exactly as in hub mode (same accounts.json), but nothing is run. The config and a request file
  // (KEY=VALUE lines with the password HASHES only) are written for the root script, which makes the accounts inside the service's own data folder.
  function installCommand() {
    for (const [what, v] of [['module folder', moduleDir], ['request file', paths.request]]) {
      if (!v) throw new Error(`The ${what} is not known, so the install command cannot be made.`);
      if (String(v).includes("'")) throw new Error(`The ${what} has a single quote in its name, so the install command cannot be made.`);
    }
    return `sudo bash '${path.join(moduleDir, 'service', 'install.sh')}' '${paths.request}'`;
  }
  const restartCommand = () => `sudo systemctl restart ${serviceName}`;
  function bootstrapService() {
    const cfg = configFor(settings, { service: true });
    const cfgText = JSON.stringify(cfg, null, 2) + '\n';
    const existing = readAccountsStrict();
    // Installed with these very settings: nothing to hand to the root script (no request file with hashes lying around).
    if (existing && fs.existsSync(paths.installed)) {
      let same = false;
      try { same = fs.readFileSync(paths.serviceConfig, 'utf8') === cfgText; } catch { same = false; }
      if (same) return { created: false, needsService: false };
    }
    const created = !existing;
    const a = existing || {
      admin: { user: 'admin', pass: crypto.randomBytes(24).toString('base64url') },
      agent: { user: 'maestro', pass: crypto.randomBytes(24).toString('base64url') },
      createdAt: new Date(now()).toISOString(),
    };
    // The paths as given are checked (a "." or ".." part is refused before anything is normalised), because the root script refuses them too.
    const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(p));
    // app = the hub's install folder (the module sits in <app>/modules/<id>); the service is kept from seeing it at all.
    // (A missing or quoted module folder is named as such by installCommand below.)
    const values = { home: abs(home), runtime: abs(runtimeDir), node: process.execPath };
    if (moduleDir && !String(moduleDir).includes("'")) values.app = path.resolve(moduleDir, '..', '..');
    const bad = Object.entries(values).filter(([, v]) => !SAFE_PATH_RE.test(v) || v.split('/').some((c) => c === '.' || c === '..')).map(([k]) => k);
    if (bad.length) throw new Error(`The service cannot be set up: the ${bad.join(', ')} path has characters other than letters, digits and . _ - /, or has a . or .. part.`);
    const allowed = settings.agent_allowed === undefined || settings.agent_allowed === null || String(settings.agent_allowed).trim() === '' ? DEFAULT_ALLOWED : String(settings.agent_allowed);
    if (/[\r\n]/.test(allowed)) throw new Error('The allowed addresses are not valid.');
    const command = installCommand();
    fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(paths.serviceDir, { recursive: true, mode: 0o700 });
    if (created) {
      try { fs.unlinkSync(paths.pendingFile); } catch { /* none, as it should be */ }
      writeFileAtomic(paths.accountsFile, JSON.stringify(a, null, 2) + '\n');
    }
    writeFileAtomic(paths.serviceConfig, cfgText);
    const lines = [
      'MMR_VERSION=1', `MMR_NAME=${serviceName}`, `MMR_HUB_HOME=${values.home}`, `MMR_APP_DIR=${values.app}`, `MMR_RUNTIME_DIR=${values.runtime}`, `MMR_NODE=${values.node}`,
      `MMR_MESH_VERSION=${VERSION}`, `MMR_CONTROL_PORT=${cfg.settings.port}`, `MMR_AGENT_ALLOWED=${allowed}`,
      `MMR_ADMIN_USER=${a.admin.user}`, `MMR_ADMIN_HASH=${hashPassword(a.admin.pass).arg}`,
      `MMR_AGENT_USER=${a.agent.user}`, `MMR_AGENT_HASH=${hashPassword(a.agent.pass).arg}`,
    ];
    writeFileAtomic(paths.request, lines.join('\n') + '\n');
    return { created, needsService: true, command };
  }

  async function bootstrap() {
    if (service) return bootstrapService();
    const my = epoch;
    const alive = () => { if (epoch !== my) throw cancelled(); };
    if (readAccountsStrict()) return { created: false };
    if (isRunning()) throw new Error('The server is running; the first accounts can only be made while it is stopped.');
    writeConfig();
    try { fs.unlinkSync(paths.pendingFile); } catch { /* none, as it should be */ }
    const accountPass = { admin: crypto.randomBytes(24).toString('base64url'), maestro: crypto.randomBytes(24).toString('base64url') };
    const secrets = [accountPass.admin, accountPass.maestro];
    const step = async (what, extra, hashed) => {
      alive();
      log(`bootstrap: ${what}`);
      const sec = hashed ? [...secrets, hashed.salt, hashed.hash, hashed.arg] : secrets;
      const { err, out } = await runExec([...baseArgs(), ...extra]);
      alive();
      return { err, out, sec, ok: /\bDone\./.test(out) && !(err && err.killed), what };
    };
    const fail = (r) => new Error(`Could not ${r.what}: ${tailLines(r.out, r.sec) || clean(redact(r.err && r.err.message, r.sec), 120) || 'no output'}`);
    const account = async (user, pass) => {
      const h = hashPassword(pass);
      let r = await step(`create the ${user === 'admin' ? 'admin' : 'agent'} account`, ['--createaccount', user, '--hashpass', h.arg], h);
      if (!r.ok && /already exists/i.test(r.out)) {
        r = await step(`reset the ${user === 'admin' ? 'admin' : 'agent'} account's password`, ['--resetaccount', user, '--hashpass', h.arg], h);
      }
      if (!r.ok) throw fail(r);
    };
    await account('admin', accountPass.admin);
    const adm = await step('make admin an administrator', ['--adminaccount', 'admin'], null);
    if (!adm.ok) throw fail(adm);
    await account('maestro', accountPass.maestro);
    alive();
    writeFileAtomic(paths.accountsFile, JSON.stringify({
      admin: { user: 'admin', pass: accountPass.admin },
      agent: { user: 'maestro', pass: accountPass.maestro },
      createdAt: new Date(now()).toISOString(),
    }, null, 2) + '\n');
    return { created: true };
  }

  function accounts() {
    const a = readJsonFile(paths.accountsFile);
    if (!a || !a.admin || !a.agent) throw new Error('The server accounts have not been made yet.');
    return a;
  }

  // The remembered device group (and anything else that must survive a restart).
  const state = {
    read() { try { return readJsonFile(paths.stateFile) || {}; } catch { return {}; } },
    write(obj) { fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 }); writeFileAtomic(paths.stateFile, JSON.stringify(obj, null, 2) + '\n'); },
  };

  // ── the log ──
  // The child's output goes through this writer: meshcentral.log, moved to meshcentral.log.1 whenever it passes 10 MB (two files at most).
  function openLogWriter() {
    fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
    let fd = null, size = 0;
    const open = () => { fd = fs.openSync(paths.logFile, 'a', 0o600); size = fs.fstatSync(fd).size; };
    const rotate = () => {
      try { if (fd !== null) fs.closeSync(fd); } catch { /* closed */ }
      fd = null;
      try { fs.renameSync(paths.logFile, `${paths.logFile}.1`); } catch { /* no log yet */ }
      open();
    };
    open();
    if (size > LOG_ROTATE_BYTES) rotate();
    return {
      write(chunk) {
        if (fd === null) return;
        try {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          for (let off = 0; off < buf.length;) off += fs.writeSync(fd, buf, off, buf.length - off);
          size += buf.length;
          if (size > LOG_ROTATE_BYTES) rotate();
        } catch { /* a full disk loses log lines; it must not stop the server */ }
      },
      close() { if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } fd = null; } },
    };
  }
  function logTail(n = 12) {
    if (service) return `MeshCentral runs as the system service ${serviceName}; its log: journalctl -u ${serviceName}`;
    try {
      const fd = fs.openSync(paths.logFile, 'r');
      try {
        const size = fs.fstatSync(fd).size, len = Math.min(size, 8192), buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        return buf.toString('utf8').split(/\r?\n/).map((l) => clean(l, 200).trim()).filter(Boolean).slice(-n).join(' | ');
      } finally { fs.closeSync(fd); }
    } catch { return ''; }
  }

  // ── a process an earlier run left behind ──
  // meshcentral.pid holds the pid of the process we started. Only a process whose command line has OUR meshcentral.js and OUR --datapath is ever signalled.
  const procArgs = (pid) => { try { return fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8').split('\0').filter(Boolean); } catch { return null; } };
  const isOurs = (args) => !!args && args.includes(paths.mainJs) && args.some((a, i) => a === '--datapath' && args[i + 1] === paths.dataPath);
  const removePid = (pid) => {
    try { if (pid === undefined || fs.readFileSync(paths.pidFile, 'utf8').trim() === String(pid)) fs.unlinkSync(paths.pidFile); } catch { /* none */ }
  };
  async function reapOrphan(my) {
    let raw;
    try { raw = fs.readFileSync(paths.pidFile, 'utf8').trim(); } catch { return; }
    const pid = /^\d{1,9}$/.test(raw) ? Number(raw) : 0;
    const signal = (sig) => {
      if (!isOurs(procArgs(pid))) return;   // looked at again before every signal: the number may belong to someone else by now
      try { killPid(pid, sig); } catch (e) { if (!e || e.code !== 'ESRCH') throw e; }
    };
    if (pid > 1 && pid !== process.pid && !(child && child.pid === pid) && isOurs(procArgs(pid))) {
      log('an old MeshCentral process is still running; stopping it');
      signal('SIGTERM');
      const t0 = now();
      let killed = false;
      while (isOurs(procArgs(pid))) {
        if (epoch !== my) throw cancelled();
        const waited = now() - t0;
        if (!killed && waited >= ORPHAN_TERM_MS) { signal('SIGKILL'); killed = true; }
        if (killed && waited >= ORPHAN_TERM_MS + 5000) throw new Error('An old MeshCentral process would not stop.');
        await nap(200);
      }
    }
    removePid();
  }

  // ── process ──
  const st = { startedAt: null, restarts: 0, lastError: null, delayIdx: 0 };

  function onExit(proc, code, signal) {
    if (child !== proc) return;
    child = null;
    removePid(proc.pid);
    if (stableTimer) { timers.clearTimeout(stableTimer); stableTimer = null; }
    for (const w of exitWaiters.splice(0)) w();
    if (stopping) return;
    st.lastError = clean(`MeshCentral stopped (${signal || `exit code ${code}`}). ${logTail(3)}`, 400);
    st.restarts += 1;
    scheduleRetry('MeshCentral stopped unexpectedly');
  }

  // The back-off 5 s, 30 s, 2 min, 10 min: after a crash, and after a start that failed before any process was made.
  function scheduleRetry(why) {
    if (restartTimer || stopping) return;
    const delay = RESTART_DELAYS_MS[Math.min(st.delayIdx, RESTART_DELAYS_MS.length - 1)];
    st.delayIdx += 1;
    log(`${why}; trying again in ${Math.round(delay / 1000)} s`);
    restartTimer = timers.setTimeout(() => {
      restartTimer = null;
      start().then(() => { if (typeof onRetryReady === 'function') { try { onRetryReady(); } catch { /* not ours to fail */ } } }, (e) => log('restart failed:', clean(e && e.message, 120)));
    }, delay);
    if (restartTimer && restartTimer.unref) restartTimer.unref();
  }

  async function waitReady(proc, my) {
    const port = Number(configFor().settings.port);
    const t0 = now();
    for (;;) {
      if (child !== proc) throw new Error(`MeshCentral stopped while starting. ${logTail()}`.trim());
      if (epoch !== my) throw cancelled();
      if (fs.existsSync(paths.rootCert) && await probe(port, '127.0.0.1').catch(() => false)) return;
      if (now() - t0 >= READY_MS) {
        try { proc.kill('SIGKILL'); } catch { /* gone */ }
        throw new Error(`MeshCentral did not become ready within ${READY_MS / 1000} s. ${logTail()}`.trim());
      }
      await nap(POLL_MS);
    }
  }

  // -- service mode: the system service is not ours to start or stop; the module only looks whether it answers --
  const NOT_INSTALLED_MESSAGE = (command) => `MeshCentral needs to be installed as its own service once. Run this in a terminal on this computer (it asks for an administrator password), or press Ask Maestro: ${command}`;
  const NOT_RUNNING_MESSAGE = (command) => `MeshCentral is installed as the system service ${serviceName} but it does not answer. Restart it in a terminal on this computer (it asks for an administrator password), or press Ask Maestro: ${command}`;
  const NEEDS_UPDATE_MESSAGE = (command) => `The settings changed after MeshCentral was installed as the system service ${serviceName}. Run the install again in a terminal on this computer (it asks for an administrator password), or press Ask Maestro: ${command}`;

  // Looks at the service now: installed.json and the root certificate must exist and the control port must answer. Never throws for a missing service.
  async function checkService() {
    const my = epoch;
    let result;
    if (!fs.existsSync(paths.installed)) {
      if (!fs.existsSync(paths.request)) await bootstrap();
      const command = installCommand();
      result = { ready: false, reason: 'not-installed', message: NOT_INSTALLED_MESSAGE(command), command };
    } else if (fs.existsSync(paths.request)) {   // installed, but bootstrap wrote a new request because the settings changed since
      const command = installCommand();
      result = { ready: false, reason: 'needs-update', message: NEEDS_UPDATE_MESSAGE(command), command };
    } else {
      const port = Number(configFor().settings.port);
      const up = fs.existsSync(paths.rootCert) && await probe(port, '127.0.0.1').catch(() => false);
      const command = restartCommand();
      result = up ? { ready: true, reason: null, message: null, command: null } : { ready: false, reason: 'not-running', message: NOT_RUNNING_MESSAGE(command), command };
    }
    if (epoch !== my) throw cancelled();
    Object.assign(svc, result);
    return { mode: 'service', ...result };
  }

  // Until the service answers, look again every 30 s so that the module connects by itself once the owner has installed it.
  function armReprobe() {
    if (svc.timer || stopping) return;
    svc.timer = timers.setTimeout(async () => {
      svc.timer = null;
      let r = null;
      try { r = await checkService(); } catch (e) { if (!e || e.code !== 'ECANCEL') log('service check failed:', clean(e && e.message, 120)); }
      if (stopping) return;
      if (r && r.ready) { if (typeof onRetryReady === 'function') { try { onRetryReady(); } catch { /* not ours to fail */ } } } else armReprobe();
    }, REPROBE_MS);
    if (svc.timer && svc.timer.unref) svc.timer.unref();
  }

  function startService() {
    if (starting) return starting;
    stopping = false;
    const my = epoch;
    starting = (async () => {
      fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
      await reapOrphan(my);   // a process the hub mode of an earlier version left behind
      if (epoch !== my) throw cancelled();
      const r = await checkService();
      if (!r.ready) armReprobe();
      return r.ready ? { pid: null, already: false, ready: true, mode: 'service' } : r;
    })();
    const done = () => { starting = null; };
    starting.then(done, done);
    return starting;
  }

  // Starts MeshCentral and resolves when it is ready. One process at a time; a second call while one is running or starting joins it.
  function start() {
    if (service) return startService();
    if (starting) return starting;
    if (child) return Promise.resolve({ pid: child.pid, already: true });
    stopping = false;
    if (restartTimer) { timers.clearTimeout(restartTimer); restartTimer = null; }
    const my = epoch;
    starting = (async () => {
      let spawned = false;
      try {
        if (!fs.existsSync(paths.mainJs)) throw coded('MeshCentral is not installed (Reinstall needed).', 'ENOTINSTALLED');
        writeConfig();
        fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
        await reapOrphan(my);
        if (epoch !== my) throw cancelled();
        const logw = openLogWriter();
        let proc;
        try {
          proc = spawn(process.execPath, baseArgs(), { cwd: runtimeDir, env: { ...baseEnv(), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) { logw.close(); throw e; }
        spawned = true;
        child = proc;
        st.startedAt = now();
        if (proc.stdout && proc.stderr) {
          for (const s of [proc.stdout, proc.stderr]) { s.on('data', logw.write); s.on('error', () => {}); }
          proc.once('close', logw.close);
        } else proc.once('exit', logw.close);
        try { writeFileAtomic(paths.pidFile, `${proc.pid}\n`); } catch (e) { log('could not write the pid file:', clean(e && (e.code || e.message), 80)); }
        proc.on('exit', (code, signal) => onExit(proc, code, signal));
        proc.on('error', (e) => { st.lastError = clean(e && e.message, 200); onExit(proc, null, 'error'); });
        await waitReady(proc, my);
        st.lastError = null;
        stableTimer = timers.setTimeout(() => { stableTimer = null; st.delayIdx = 0; }, STABLE_MS);
        if (stableTimer && stableTimer.unref) stableTimer.unref();
        return { pid: proc.pid, already: false };
      } catch (e) {
        if (!spawned && epoch === my && !stopping && e && e.code !== 'ENOTINSTALLED' && e.code !== 'ECANCEL') {
          st.lastError = clean(`MeshCentral could not be started (${e.message}).`, 400);
          scheduleRetry('MeshCentral could not be started');
        }
        throw e;
      }
    })();
    const done = () => { starting = null; };
    starting.then(done, done);
    return starting;
  }

  // Stops everything: account commands (SIGTERM, SIGKILL after 5 s), the server (SIGTERM, SIGKILL after 10 s), pending restarts and a start in progress.
  async function stop() {
    epoch += 1;
    stopping = true;
    if (svc.timer) { timers.clearTimeout(svc.timer); svc.timer = null; }   // service mode: no signal is ever sent to the service
    if (restartTimer) { timers.clearTimeout(restartTimer); restartTimer = null; }
    if (stableTimer) { timers.clearTimeout(stableTimer); stableTimer = null; }
    for (const w of exitWaiters.splice(0)) w();
    const boot = stopBootProcs();
    const proc = child;
    if (proc) {
      const gone = new Promise((r) => exitWaiters.push(r));
      try { proc.kill('SIGTERM'); } catch { /* gone */ }
      let killer;
      const killed = new Promise((r) => { killer = timers.setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } r(); }, KILL_AFTER_MS); });
      await Promise.race([gone, killed]);
      timers.clearTimeout(killer);
      if (child === proc) await Promise.race([gone, sleep(1000)]);
    }
    await boot;
    if (starting) await starting.catch(() => {});
  }

  function status() {
    if (service) return { running: svc.ready, pid: null, startedAt: null, restarts: 0, lastError: null, mode: 'service', reason: svc.reason, message: svc.message, command: svc.command };
    return {
      running: !!child,
      pid: child ? child.pid : null,
      startedAt: child && st.startedAt ? new Date(st.startedAt).toISOString() : null,
      restarts: st.restarts,
      lastError: st.lastError,
    };
  }

  return { paths, mode: service ? 'service' : 'hub', configFor, writeConfig, npmGuardArgs, bootstrap, accounts, state, start, stop, status, isRunning, logTail, checkService };
}

module.exports = { createMeshServer, DEFAULT_SERVICE_NAME, SERVICE_NAME_RE, REPROBE_MS, writeFileAtomic, tlsProbe, hashPassword, redact, VERSION, GROUP_NAME, RESTART_DELAYS_MS, NPM_GUARD, DNS_RE, IPV4_RE, LOG_ROTATE_BYTES };
