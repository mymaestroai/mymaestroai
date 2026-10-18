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
    const server = path.join(dir, 'server.js');
    if (platform === 'darwin') {
      try {
        for (const f of fs.readdirSync(agentsDir)) {
          if (!f.endsWith('.plist')) continue;
          let txt = '';
          try { txt = fs.readFileSync(path.join(agentsDir, f), 'utf8'); } catch { continue; }   // a broken link or an unreadable file: skip it
          if (txt.includes(server)) return { kind: 'launchd', label: f.replace(/\.plist$/, '') };
        }
      } catch { /* no agents folder */ }
      return { kind: 'none' };
    }
    try {
      for (const f of fs.readdirSync(unitDir)) {
        if (!f.endsWith('.service')) continue;
        let txt = '';
        try { txt = fs.readFileSync(path.join(unitDir, f), 'utf8'); } catch { continue; }   // a broken link (a removed service) must not end the search
        if (txt.includes(server) || (txt.includes(`WorkingDirectory=${dir}`) && /server\.js/.test(txt))) return { kind: 'systemd', unit: f };
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
  function install({ node = process.execPath, unit = DEFAULT_UNIT, label = DEFAULT_LABEL } = {}) {
    const notes = [];
    if (platform === 'darwin') {
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
    const child = spawn(node, [path.join(dir, 'server.js')], { cwd: dir, detached: true, stdio: ['ignore', log, log], env: process.env });
    child.unref();
    fs.writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
    return { ok: true, kind: 'none', pid: child.pid };
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

  return { dir, home, platform, readInstall, writeInstall, detect, state, install, remove, start, stop, restart, unitDir, agentsDir };
}

module.exports = { createServiceManager, renderSystemdUnit, renderLaunchdPlist, servicePath, DEFAULT_UNIT, DEFAULT_LABEL, RESTART_EXIT };
