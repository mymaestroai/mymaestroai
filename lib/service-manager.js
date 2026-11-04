'use strict';

/**
 * service-manager.js — run the hub as a background service that starts on its own and comes back after a restart:
 * a systemd user unit on Linux (with "linger", so it starts at boot), a launchd agent on macOS (starts at login).
 * Used by the installer (through `mymaestro service install`) and by `mymaestro start|stop|restart|status`.
 *
 * Install facts are kept in data/install.json: { product, dir, port, node, service, unit, label, bin, stateDir, channel }.
 * Hubs installed before the installer existed have no such file; their service is found by looking for a unit or a
 * launchd agent whose command runs this folder's server.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const HUB_DIR = path.join(__dirname, '..');
const DEFAULT_UNIT = 'mymaestroai.service';
const DEFAULT_LABEL = 'ai.mymaestro.hub';
const RESTART_EXIT = 75;   // lib/restart.js: the hub exits with 75 to be restarted by its supervisor

// A hub started by `mymaestro start` (the installer starts it that way too) gets an allow-listed environment from the
// shell that started it: where things are, language and time zone, proxies and certificates. Not that shell's provider
// keys (OPENAI_API_KEY from ~/.zshrc), tokens, HUB_* settings (an agent's shell carries HUB_AGENT_PERMISSION_MODE=
// bypassPermissions from the hub running it), CLAUDE_CODE_* or NODE_OPTIONS: a hub's settings come from its own .env and
// data/settings.json. Kept: the user's SSH agent (git over SSH for Update when the key lives only in the agent) and where
// the Claude and Codex sign-ins are kept (CLAUDE_CONFIG_DIR, CODEX_HOME): paths of the same user, not secrets. The
// services (plist, unit) set their own short environment and never see the caller's.
const START_ENV_KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_\w+|TZ|TMPDIR|TMP|TEMP|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|SSL_CERT_(FILE|DIR)|NODE_EXTRA_CA_CERTS|XDG_(CONFIG|CACHE|DATA|STATE)_HOME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|SSH_AUTH_SOCK|CLAUDE_CONFIG_DIR|CODEX_HOME)$/;
function startEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (START_ENV_KEEP.test(k) && v !== undefined) out[k] = v;
  return out;
}

// What people may have relied on their shell for before starts were allow-listed: provider and web-search keys, the
// port, the shared folder. Each one the caller's shell has but the hub's own config (data/settings.json, .env) lacks gets
// a plain notice naming the variable, never its value, so `mymaestro start` doesn't silently lose a working setup.
const KEY_LABELS = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Gemini', perplexity: 'Perplexity', openrouter: 'OpenRouter',
                     brave: 'Brave Search', serper: 'Serper', tavily: 'Tavily' };
// The variable names lib/settings.js reads (copied, not required: loading settings.js logs, and `mymaestro start` should
// print only what matters; test/service-manager.test.js keeps the copies equal).
const ENV_KEY_MAP = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY', perplexity: 'PERPLEXITY_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
const SEARCH_ENV_KEY_MAP = { brave: 'BRAVE_SEARCH_API_KEY', serper: 'SERPER_API_KEY', tavily: 'TAVILY_API_KEY' };
function envNotices({ env = process.env, dir = HUB_DIR, fsImpl = fs } = {}) {
  let settings = {};
  try { settings = JSON.parse(fsImpl.readFileSync(path.join(dir, 'data', 'settings.json'), 'utf8')) || {}; } catch { /* none yet */ }
  const envFile = new Set();
  try {
    for (const line of fsImpl.readFileSync(path.join(dir, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);   // the rule server.js loads .env by
      if (m && m[2].trim()) envFile.add(m[1]);
    }
  } catch { /* no .env */ }
  const has = (k) => typeof env[k] === 'string' && env[k].trim() !== '' && !START_ENV_KEEP.test(k);
  const lead = "My Maestro AI no longer passes your shell's settings to the hub";
  const out = [];
  for (const [kind, map, where] of [['providers', ENV_KEY_MAP, 'Settings → LLM Providers'], ['search', SEARCH_ENV_KEY_MAP, 'Settings → Web search']]) {
    for (const [id, name] of Object.entries(map)) {
      if (!has(name) || envFile.has(name)) continue;
      const saved = kind === 'providers' ? settings.providers?.[id]?.apiKey : settings.webSearch?.keys?.[id];
      if (saved) continue;
      out.push(`Your ${KEY_LABELS[id] || id} key (${name}) is only set in this shell. ${lead}, so it won't see it: add the key in ${where}.`);
    }
  }
  const envPath = path.join(dir, '.env');
  if (has('PORT') && !envFile.has('PORT')) out.push(`Your shell sets PORT. ${lead}, so it uses the port in its own .env (8888 when it has none): put PORT=<port> in ${envPath} to keep yours.`);
  if (has('HUB_HOME') && !envFile.has('HUB_HOME')) out.push(`Your shell sets HUB_HOME. ${lead}, so it uses its usual shared folder: put HUB_HOME=<folder> in ${envPath} to keep yours.`);
  return out;
}

/** What a launchd plist or systemd unit runs: every server.js among its program arguments (absolute, or relative to
 *  its working directory; inside a quoted `bash -lc '… node server.js'` too) and its working directory. */
function serviceEntry(txt) {
  const unxml = (v) => v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  let args = []; let workdir = null;
  if (/<plist[\s>]/.test(txt)) {
    const list = txt.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
    args = [...(list ? list[1] : txt).matchAll(/<string>([^<]*)<\/string>/g)].map(m => unxml(m[1]));
    const prog = txt.match(/<key>Program<\/key>\s*<string>([^<]*)<\/string>/); if (prog) args.unshift(unxml(prog[1]));
    const wd = txt.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/); if (wd) workdir = unxml(wd[1]);
  } else {
    for (const m of txt.matchAll(/^[ \t]*ExecStart=(.*)$/gm)) args.push(m[1]);
    const wd = [...txt.matchAll(/^[ \t]*WorkingDirectory=-?(.*?)\s*$/gm)].pop(); if (wd) workdir = wd[1];
  }
  const servers = args.flatMap(v => v.split(/[\s'"`;&|()]+/)).filter(t => t === 'server.js' || t.endsWith('/server.js'));
  return { servers, workdir };
}
/** Whether a launchd plist or systemd unit runs the hub in this folder: every server.js it names is this folder's (a
 *  working directory alone proves nothing when the command names another hub's server.js). */
function runsFolderAt(txt, dir, real = (p) => p) {
  const { servers, workdir } = serviceEntry(txt);
  if (!servers.length) return false;
  const mine = real(path.join(dir, 'server.js'));
  return servers.every(sv => {
    const full = path.isAbsolute(sv) ? sv : (workdir && path.isAbsolute(workdir) ? path.join(workdir, sv) : null);
    return !!full && real(full) === mine;   // a relative server.js with no working directory: can't tell, so not this one
  });
}
function runsFolder(txt, dir) {
  if (runsFolderAt(txt, dir)) return true;
  // Through symlinks: the service file may name a linked path while this process sees the real one (Node resolves
  // __dirname), or the other way round. Compare real paths.
  const real = (p) => { try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return path.resolve(p); } };
  return runsFolderAt(txt, dir, real);
}

/** A per-install suffix, so a second hub on this computer gets its own service instead of replacing the first one's. */
function installSuffix(dir) { return require('crypto').createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 8); }

function servicePath(nodeBin, home, platform) {
  const dirs = [path.dirname(nodeBin), path.join(home, '.local', 'bin')];
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  else dirs.push('/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  return [...new Set(dirs)].join(':');
}

/** The systemd user unit. Output goes to server.log in the program folder, like every other way of running it. */
function renderSystemdUnit({ dir, node, home = os.homedir(), product = 'My Maestro AI' }) {
  return [
    '[Unit]',
    `Description=${product}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${dir}`,
    `ExecStart=${node} ${path.join(dir, 'server.js')}`,
    'Restart=always',
    'RestartSec=2',
    `Environment=PATH=${servicePath(node, home, 'linux')}`,
    `Environment=HOME=${home}`,
    'Environment=NODE_ENV=production',
    `StandardOutput=append:${path.join(dir, 'server.log')}`,
    `StandardError=append:${path.join(dir, 'server.log')}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function xml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
/** The launchd agent: starts at login, restarted whenever it exits (the hub's own restart exits with 75). */
function renderLaunchdPlist({ label = DEFAULT_LABEL, dir, node, home = os.homedir() }) {
  const log = path.join(dir, 'server.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(path.join(dir, 'server.js'))}</string></array>
  <key>WorkingDirectory</key><string>${xml(dir)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${xml(servicePath(node, home, 'darwin'))}</string>
    <key>HOME</key><string>${xml(home)}</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

function createServiceManager(opts = {}) {
  const dir = opts.dir || HUB_DIR;
  const home = opts.home || os.homedir();
  const platform = opts.platform || process.platform;
  const uid = opts.uid !== undefined ? opts.uid : (process.getuid ? process.getuid() : 0);
  const run = opts.exec || ((cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }));
  const tryRun = (cmd, args) => { try { return { ok: true, out: String(run(cmd, args) || '') }; } catch (e) { return { ok: false, out: String((e.stdout || '') + (e.stderr || '') || e.message) }; } };
  const installFile = path.join(dir, 'data', 'install.json');
  const unitDir = path.join(home, '.config', 'systemd', 'user');
  const agentsDir = path.join(home, 'Library', 'LaunchAgents');

  function readInstall() { try { return JSON.parse(fs.readFileSync(installFile, 'utf8')); } catch { return {}; } }
  function writeInstall(patch) {
    const next = { ...readInstall(), ...patch };
    fs.mkdirSync(path.dirname(installFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(installFile, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    return next;
  }

  /** Which service runs this folder: { kind: 'systemd'|'launchd'|'none', unit?, label? }. */
  function detect() {
    const inst = readInstall();
    if (inst.service === 'systemd' && inst.unit) return { kind: 'systemd', unit: inst.unit };
    if (inst.service === 'launchd' && inst.label) return { kind: 'launchd', label: inst.label };
    if (platform === 'darwin') {
      try {
        for (const f of fs.readdirSync(agentsDir)) {
          if (!f.endsWith('.plist')) continue;
          let txt = '';
          try { txt = fs.readFileSync(path.join(agentsDir, f), 'utf8'); } catch { continue; }   // a broken link or an unreadable file: skip it
          if (runsFolder(txt, dir)) return { kind: 'launchd', label: f.replace(/\.plist$/, '') };
        }
      } catch { /* no agents folder */ }
      return { kind: 'none' };
    }
    try {
      for (const f of fs.readdirSync(unitDir)) {
        if (!f.endsWith('.service')) continue;
        let txt = '';
        try { txt = fs.readFileSync(path.join(unitDir, f), 'utf8'); } catch { continue; }   // a broken link (a removed service) must not end the search
        if (runsFolder(txt, dir)) return { kind: 'systemd', unit: f };
      }
    } catch { /* no user units */ }
    return { kind: 'none' };
  }

  function state() {
    const s = detect();
    if (s.kind === 'systemd') {
      const r = tryRun('systemctl', ['--user', 'is-active', s.unit]);
      const enabled = tryRun('systemctl', ['--user', 'is-enabled', s.unit]);
      return { ...s, active: r.out.trim() === 'active', status: r.out.trim() || 'unknown', enabled: enabled.out.trim() === 'enabled' };
    }
    if (s.kind === 'launchd') {
      const r = tryRun('launchctl', ['print', `gui/${uid}/${s.label}`]);
      return { ...s, active: r.ok && /state = running/.test(r.out), status: r.ok ? ((r.out.match(/state = (\w+)/) || [])[1] || 'loaded') : 'not loaded', enabled: fs.existsSync(path.join(agentsDir, `${s.label}.plist`)) };
    }
    return { kind: 'none', active: false, status: 'no service', enabled: false };
  }

  /** Install and start the service. Returns { ok, kind, notes[] }. */
  /** The service name for this folder: the one it was installed under, else the default unless another folder's hub
   *  already uses it, else the default with this folder's suffix (ai.mymaestro.hub.1a2b3c4d, mymaestroai-1a2b3c4d.service). */
  function serviceName(kind) {
    // the one recorded in data/install.json, or a service already running this folder under any name (the legacy
    // com.agent-hub, a hand-made unit): a reinstall replaces it rather than adding a second service for the same hub
    const found = detect();
    if (found.kind === kind && (found.label || found.unit)) return found.label || found.unit;
    const [file, def, alt] = kind === 'launchd'
      ? [(n) => path.join(agentsDir, `${n}.plist`), DEFAULT_LABEL, `${DEFAULT_LABEL}.${installSuffix(dir)}`]
      : [(n) => path.join(unitDir, n), DEFAULT_UNIT, DEFAULT_UNIT.replace(/\.service$/, `-${installSuffix(dir)}.service`)];
    let txt = null;
    try { txt = fs.readFileSync(file(def), 'utf8'); } catch { return def; }
    return runsFolder(txt, dir) ? def : alt;
  }

  function install({ node = process.execPath, unit = null, label = null } = {}) {
    const notes = [];
    if (platform === 'darwin') {
      label = label || serviceName('launchd');
      fs.mkdirSync(agentsDir, { recursive: true });
      const plist = path.join(agentsDir, `${label}.plist`);
      tryRun('launchctl', ['bootout', `gui/${uid}/${label}`]);   // an older copy of this agent, if loaded
      fs.writeFileSync(plist, renderLaunchdPlist({ label, dir, node, home }), { mode: 0o644 });
      let r = tryRun('launchctl', ['bootstrap', `gui/${uid}`, plist]);
      if (!r.ok) r = tryRun('launchctl', ['load', '-w', plist]);   // older macOS
      if (!r.ok) return { ok: false, kind: 'launchd', error: `launchctl could not load the agent: ${r.out.trim().slice(0, 300)}` };
      writeInstall({ service: 'launchd', label, node, dir });
      notes.push('Starts when you log in to this Mac, and comes back by itself if it stops.');
      return { ok: true, kind: 'launchd', label, notes };
    }
    if (!tryRun('systemctl', ['--user', '--version']).ok) return { ok: false, kind: 'none', error: 'systemd is not available for this user (no "systemctl --user"). Start the hub with: mymaestro start' };
    unit = unit || serviceName('systemd');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, unit), renderSystemdUnit({ dir, node, home }), { mode: 0o644 });
    const steps = [['--user', 'daemon-reload'], ['--user', 'enable', unit], ['--user', 'restart', unit]];
    for (const a of steps) { const r = tryRun('systemctl', a); if (!r.ok) return { ok: false, kind: 'systemd', error: `systemctl ${a.join(' ')} failed: ${r.out.trim().slice(0, 300)}` }; }
    const user = os.userInfo().username;
    const linger = tryRun('loginctl', ['enable-linger', user]);
    if (linger.ok) notes.push('Starts when this computer starts, even before anyone logs in, and comes back by itself if it stops.');
    else notes.push(`Starts when you log in. To start it at boot without logging in, run once: sudo loginctl enable-linger ${user}`);
    writeInstall({ service: 'systemd', unit, node, dir });
    return { ok: true, kind: 'systemd', unit, notes };
  }

  function remove() {
    const s = detect();
    if (s.kind === 'systemd') {
      tryRun('systemctl', ['--user', 'disable', '--now', s.unit]);
      try { fs.unlinkSync(path.join(unitDir, s.unit)); } catch { /* gone */ }
      tryRun('systemctl', ['--user', 'daemon-reload']);
    } else if (s.kind === 'launchd') {
      tryRun('launchctl', ['bootout', `gui/${uid}/${s.label}`]);
      try { fs.unlinkSync(path.join(agentsDir, `${s.label}.plist`)); } catch { /* gone */ }
    }
    writeInstall({ service: 'none', unit: undefined, label: undefined });
    return { ok: true, removed: s };
  }

  const pidFile = path.join(dir, '.server.pid');
  function readPid() { try { const p = Number(fs.readFileSync(pidFile, 'utf8').trim()); return p > 0 ? p : null; } catch { return null; } }
  function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

  function start({ node = readInstall().node || process.execPath } = {}) {
    const s = detect();
    if (s.kind === 'systemd') { const r = tryRun('systemctl', ['--user', 'start', s.unit]); return { ok: r.ok, kind: s.kind, error: r.ok ? null : r.out.trim() }; }
    if (s.kind === 'launchd') {
      const plist = path.join(agentsDir, `${s.label}.plist`);
      let r = tryRun('launchctl', ['bootstrap', `gui/${uid}`, plist]);
      if (!r.ok) r = tryRun('launchctl', ['kickstart', `gui/${uid}/${s.label}`]);
      return { ok: r.ok, kind: s.kind, error: r.ok ? null : r.out.trim() };
    }
    const pid = readPid();
    if (pid && alive(pid)) return { ok: true, kind: 'none', already: true, pid };
    const log = fs.openSync(path.join(dir, 'server.log'), 'a', 0o600);
    const callerEnv = opts.env || process.env;
    const child = (opts.spawn || spawn)(node, [path.join(dir, 'server.js')], { cwd: dir, detached: true, stdio: ['ignore', log, log], env: startEnv(callerEnv) });
    child.unref();
    fs.writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
    let notices = [];
    try { notices = envNotices({ env: callerEnv, dir }); } catch { /* a notice must never stop a start */ }
    return { ok: true, kind: 'none', pid: child.pid, notices };
  }

  async function stop() {
    const s = detect();
    if (s.kind === 'systemd') { const r = tryRun('systemctl', ['--user', 'stop', s.unit]); return { ok: r.ok, kind: s.kind, error: r.ok ? null : r.out.trim() }; }
    if (s.kind === 'launchd') { const r = tryRun('launchctl', ['bootout', `gui/${uid}/${s.label}`]); return { ok: r.ok || /No such process|Could not find/i.test(r.out), kind: s.kind }; }
    const pid = readPid();
    if (!pid || !alive(pid)) return { ok: true, kind: 'none', already: true };
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 60 && alive(pid); i++) await new Promise(r => setTimeout(r, 250));
    if (alive(pid)) process.kill(pid, 'SIGKILL');
    try { fs.unlinkSync(pidFile); } catch { /* gone */ }
    return { ok: true, kind: 'none' };
  }

  async function restart() {
    const s = detect();
    if (s.kind === 'systemd') { const r = tryRun('systemctl', ['--user', 'restart', s.unit]); return { ok: r.ok, kind: s.kind, error: r.ok ? null : r.out.trim() }; }
    if (s.kind === 'launchd') { const r = tryRun('launchctl', ['kickstart', '-k', `gui/${uid}/${s.label}`]); return { ok: r.ok, kind: s.kind, error: r.ok ? null : r.out.trim() }; }
    await stop();
    return start();
  }

  return { dir, home, platform, readInstall, writeInstall, detect, state, install, remove, start, stop, restart, serviceName, unitDir, agentsDir };
}

module.exports = { createServiceManager, renderSystemdUnit, renderLaunchdPlist, servicePath, startEnv, envNotices, ENV_KEY_MAP, SEARCH_ENV_KEY_MAP, runsFolder, serviceEntry, installSuffix, START_ENV_KEEP, DEFAULT_UNIT, DEFAULT_LABEL, RESTART_EXIT };
