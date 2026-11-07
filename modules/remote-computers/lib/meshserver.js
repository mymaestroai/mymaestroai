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
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
const BOOTSTRAP_TIMEOUT_MS = 120000;
const NPM_GUARD = path.join(__dirname, 'no-npm.js');

const DNS_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_RE = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;

const clean = (s, max = 300) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ').slice(0, max);

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
  probe = tlsProbe, timers = { setTimeout, clearTimeout }, npmGuard = NPM_GUARD } = {}) {
  if (!runtimeDir || !home) throw new Error('createMeshServer needs runtimeDir and home');
  const paths = {
    home,
    dataPath: path.join(home, 'meshcentral-data'),
    filesPath: path.join(home, 'meshcentral-files'),
    accountsFile: path.join(home, 'accounts.json'),
    pendingFile: path.join(home, 'accounts.pending.json'),
    stateFile: path.join(home, 'state.json'),
    logFile: path.join(home, 'meshcentral.log'),
    mainJs: path.join(runtimeDir, 'node_modules', 'meshcentral', 'meshcentral.js'),
  };
  paths.configFile = path.join(paths.dataPath, 'config.json');
  paths.rootCert = path.join(paths.dataPath, 'root-cert-public.crt');
  const baseEnv = () => ({ PATH: process.env.PATH, HOME: home });

  // ── config ──
  // Every key below was read in MeshCentral 1.3.1 (config.json keys are lower-cased on load, meshcentral.js:4241; settings become args, meshcentral.js:187):
  //   cert (meshcentral.js:238), port/portBind (webserver.js:8386), agentPort/agentPortBind (webserver.js:8389; the .msh then carries agentPort, webserver.js:6388-6411,
  //   so no alias is set), redirPort 0 and mpsPort 0 (meshcentral.js:1686-1689: only null is replaced by a default), wanOnly (meshcentral.js:1910), exactPorts (webserver.js:9576),
  //   lockAgentDownload (webserver.js:6297,6381), userAllowedIp/agentAllowedIp (meshcentral.js:958-969), cookieIpCheck (meshcentral.js:985-987),
  //   agentDownloads {enabled, fetchReleases} (agentbuilds.js:395,229-230), autoBackup false (meshcentral.js:2211), filesPath (meshcentral.js:123), domain newAccounts (webserver.js:1784).
  function configFor(s = settings) {
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
        agentAllowedIp: '100.64.0.0/10',
        cookieIpCheck: 'strict',
        agentDownloads: { enabled: true, fetchReleases: false },
        autoBackup: false,
        filesPath: paths.filesPath,
      },
      domains: { '': { title: 'My Maestro computers', newAccounts: false } },
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

  // ── first-start accounts ──
  let child = null;       // the running MeshCentral process, if any
  const isRunning = () => !!child;

  const runExec = (args) => new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: runtimeDir, env: baseEnv(), timeout: BOOTSTRAP_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, out: `${stdout || ''}${stderr ? `\n${stderr}` : ''}` });
    });
  });
  const tailLines = (text, secrets, n = 4) => {
    let t = String(text || '');
    for (const sec of secrets) if (sec) t = t.split(sec).join('[secret]');
    return t.split(/\r?\n/).map((l) => clean(l, 200).trim()).filter(Boolean).slice(-n).join(' | ');
  };

  // Creates the accounts once, while the server is stopped (MeshCentral writes straight to its database and exits: meshcentral.js:1038-1112).
  // Passwords are made first and kept in accounts.pending.json (0600) until both accounts exist, so a failure half way can be retried.
  async function bootstrap() {
    if (fs.existsSync(paths.accountsFile)) return { created: false };
    if (isRunning()) throw new Error('The server is running; the first accounts can only be made while it is stopped.');
    writeConfig();
    let pend = null;
    try { pend = readJsonFile(paths.pendingFile); } catch { pend = null; }
    const resumed = !!(pend && typeof pend.adminPass === 'string' && typeof pend.agentPass === 'string');
    if (!resumed) {
      pend = { adminPass: crypto.randomBytes(24).toString('base64url'), agentPass: crypto.randomBytes(24).toString('base64url'), createdAt: new Date(now()).toISOString() };
      writeFileAtomic(paths.pendingFile, JSON.stringify(pend));
    }
    const secrets = [pend.adminPass, pend.agentPass];
    const steps = [
      ['create the admin account', ['--createaccount', 'admin', '--pass', pend.adminPass], true],
      ['make admin an administrator', ['--adminaccount', 'admin'], false],
      ['create the agent account', ['--createaccount', 'maestro', '--pass', pend.agentPass], true],
    ];
    for (const [what, extra, canExist] of steps) {
      log(`bootstrap: ${what}`);
      const { err, out } = await runExec([...baseArgs(), ...extra]);
      const exists = resumed && canExist && /already exists/i.test(out);   // an earlier try made it with this same password
      if (!exists && !(/\bDone\./.test(out) && !(err && err.killed))) {
        throw new Error(`Could not ${what}: ${tailLines(out, secrets) || clean(err && err.message, 120) || 'no output'}`);
      }
    }
    writeFileAtomic(paths.accountsFile, JSON.stringify({
      admin: { user: 'admin', pass: pend.adminPass },
      agent: { user: 'maestro', pass: pend.agentPass },
      createdAt: new Date(now()).toISOString(),
    }, null, 2) + '\n');
    try { fs.unlinkSync(paths.pendingFile); } catch { /* already gone */ }
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

  // ── process ──
  const st = { startedAt: null, restarts: 0, lastError: null, delayIdx: 0 };
  let stopping = false, starting = null, restartTimer = null, stableTimer = null, exitWaiters = [];
  const sleep = (ms) => new Promise((r) => timers.setTimeout(r, ms));

  function rotateLog() {
    try { if (fs.statSync(paths.logFile).size > LOG_ROTATE_BYTES) fs.renameSync(paths.logFile, `${paths.logFile}.1`); } catch { /* no log yet */ }
  }
  function logTail(n = 12) {
    try {
      const fd = fs.openSync(paths.logFile, 'r');
      try {
        const size = fs.fstatSync(fd).size, len = Math.min(size, 8192), buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        return buf.toString('utf8').split(/\r?\n/).map((l) => clean(l, 200).trim()).filter(Boolean).slice(-n).join(' | ');
      } finally { fs.closeSync(fd); }
    } catch { return ''; }
  }

  function onExit(proc, code, signal) {
    if (child !== proc) return;
    child = null;
    if (stableTimer) { timers.clearTimeout(stableTimer); stableTimer = null; }
    for (const w of exitWaiters.splice(0)) w();
    if (stopping) return;
    st.lastError = clean(`MeshCentral stopped (${signal || `exit code ${code}`}). ${logTail(3)}`, 400);
    const delay = RESTART_DELAYS_MS[Math.min(st.delayIdx, RESTART_DELAYS_MS.length - 1)];
    st.delayIdx += 1;
    st.restarts += 1;
    log(`MeshCentral stopped unexpectedly; restarting in ${Math.round(delay / 1000)} s`);
    restartTimer = timers.setTimeout(() => {
      restartTimer = null;
      start().catch((e) => log('restart failed:', clean(e && e.message, 120)));
    }, delay);
    if (restartTimer && restartTimer.unref) restartTimer.unref();
  }

  async function waitReady(proc) {
    const port = Number(configFor().settings.port);
    const t0 = now();
    for (;;) {
      if (child !== proc) throw new Error(`MeshCentral stopped while starting. ${logTail()}`.trim());
      if (fs.existsSync(paths.rootCert) && await probe(port, '127.0.0.1').catch(() => false)) return;
      if (now() - t0 >= READY_MS) {
        try { proc.kill('SIGKILL'); } catch { /* gone */ }
        throw new Error(`MeshCentral did not become ready within ${READY_MS / 1000} s. ${logTail()}`.trim());
      }
      await new Promise((resolve) => {   // wakes early when the process exits
        const h = timers.setTimeout(resolve, POLL_MS);
        exitWaiters.push(() => { timers.clearTimeout(h); resolve(); });
      });
    }
  }

  // Starts MeshCentral and resolves when it is ready. One process at a time; a second call while one is running or starting joins it.
  function start() {
    if (starting) return starting;
    if (child) return Promise.resolve({ pid: child.pid, already: true });
    stopping = false;
    if (restartTimer) { timers.clearTimeout(restartTimer); restartTimer = null; }
    starting = (async () => {
      if (!fs.existsSync(paths.mainJs)) throw new Error('MeshCentral is not installed (Reinstall needed).');
      writeConfig();
      fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
      rotateLog();
      const fd = fs.openSync(paths.logFile, 'a', 0o600);
      let proc;
      try {
        proc = spawn(process.execPath, baseArgs(), { cwd: runtimeDir, env: { ...baseEnv(), NODE_ENV: 'production' }, stdio: ['ignore', fd, fd] });
      } finally { fs.closeSync(fd); }
      child = proc;
      st.startedAt = now();
      proc.on('exit', (code, signal) => onExit(proc, code, signal));
      proc.on('error', (e) => { st.lastError = clean(e && e.message, 200); onExit(proc, null, 'error'); });
      await waitReady(proc);
      st.lastError = null;
      stableTimer = timers.setTimeout(() => { stableTimer = null; st.delayIdx = 0; }, STABLE_MS);
      if (stableTimer && stableTimer.unref) stableTimer.unref();
      return { pid: proc.pid, already: false };
    })();
    const done = () => { starting = null; };
    starting.then(done, done);
    return starting;
  }

  // SIGTERM, then SIGKILL after 10 s. Cancels any pending restart.
  async function stop() {
    stopping = true;
    if (restartTimer) { timers.clearTimeout(restartTimer); restartTimer = null; }
    if (stableTimer) { timers.clearTimeout(stableTimer); stableTimer = null; }
    const proc = child;
    if (!proc) return;
    const gone = new Promise((r) => exitWaiters.push(r));
    try { proc.kill('SIGTERM'); } catch { /* gone */ }
    let killer;
    const killed = new Promise((r) => { killer = timers.setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } r(); }, KILL_AFTER_MS); });
    await Promise.race([gone, killed]);
    timers.clearTimeout(killer);
    if (child === proc) await Promise.race([gone, sleep(1000)]);
  }

  function status() {
    return {
      running: !!child,
      pid: child ? child.pid : null,
      startedAt: child && st.startedAt ? new Date(st.startedAt).toISOString() : null,
      restarts: st.restarts,
      lastError: st.lastError,
    };
  }

  return { paths, configFor, writeConfig, npmGuardArgs, bootstrap, accounts, state, start, stop, status, isRunning, logTail };
}

module.exports = { createMeshServer, writeFileAtomic, tlsProbe, VERSION, GROUP_NAME, RESTART_DELAYS_MS, NPM_GUARD, DNS_RE, IPV4_RE };
