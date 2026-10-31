'use strict';
// lib/service-manager: the systemd user unit / launchd agent that keeps My Maestro AI running, used by the installer
// and the mymaestro command. Commands are recorded, never run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServiceManager, renderSystemdUnit, renderLaunchdPlist, startEnv } = require('../lib/service-manager');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'svcmgr-'));
  const home = path.join(root, 'home'), dir = path.join(root, 'app');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  return { root, home, dir };
}
function recorder(responses = {}) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    const key = Object.keys(responses).find(k => [cmd, ...args].join(' ').startsWith(k));
    const r = key ? responses[key] : '';
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, exec };
}

test('the systemd unit runs this folder\'s server.js with the private Node, restarts always, logs to server.log', () => {
  const u = renderSystemdUnit({ dir: '/home/u/mymaestroai', node: '/home/u/.mymaestroai/node/bin/node', home: '/home/u' });
  assert.match(u, /^ExecStart=\/home\/u\/\.mymaestroai\/node\/bin\/node \/home\/u\/mymaestroai\/server\.js$/m);
  assert.match(u, /^WorkingDirectory=\/home\/u\/mymaestroai$/m);
  assert.match(u, /^Restart=always$/m);
  assert.match(u, /^Environment=PATH=\/home\/u\/\.mymaestroai\/node\/bin:\/home\/u\/\.local\/bin:/m, 'its own Node and ~/.local/bin (claude) first');
  assert.match(u, /^StandardOutput=append:\/home\/u\/mymaestroai\/server\.log$/m);
  assert.match(u, /^WantedBy=default\.target$/m);
});

test('the launchd agent starts at login, is kept alive (the hub restarts itself by exiting), and escapes XML', () => {
  const p = renderLaunchdPlist({ label: 'ai.mymaestro.hub', dir: '/Users/a&b/mymaestroai', node: '/Users/a&b/.mymaestroai/node/bin/node', home: '/Users/a&b' });
  assert.match(p, /<key>Label<\/key><string>ai\.mymaestro\.hub<\/string>/);
  assert.match(p, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(p, /<key>KeepAlive<\/key><true\/>/);
  assert.ok(p.includes('/Users/a&amp;b/mymaestroai/server.js') && !p.includes('/Users/a&b/'), 'paths are escaped');
  assert.match(p, /\/opt\/homebrew\/bin/);
});

test('install on Linux: writes the unit, reloads, enables, restarts, asks for linger, records data/install.json', () => {
  const { home, dir } = sandbox();
  const r = recorder();
  const m = createServiceManager({ dir, home, platform: 'linux', exec: r.exec });
  const res = m.install({ node: '/n/bin/node' });
  assert.strictEqual(res.ok, true, res.error);
  assert.ok(fs.existsSync(path.join(home, '.config/systemd/user/mymaestroai.service')));
  assert.deepStrictEqual(r.calls.filter(c => c.startsWith('systemctl --user ') && !c.includes('--version')), ['systemctl --user daemon-reload', 'systemctl --user enable mymaestroai.service', 'systemctl --user restart mymaestroai.service']);
  assert.ok(r.calls.some(c => c.startsWith('loginctl enable-linger ')));
  assert.deepStrictEqual({ service: m.readInstall().service, unit: m.readInstall().unit }, { service: 'systemd', unit: 'mymaestroai.service' });
  assert.strictEqual(fs.statSync(path.join(dir, 'data/install.json')).mode & 0o777, 0o600);
  assert.deepStrictEqual(m.detect(), { kind: 'systemd', unit: 'mymaestroai.service' });
  // linger refused: still installed, with the one command that fixes it
  const r2 = recorder({ 'loginctl enable-linger': new Error('Access denied') });
  const res2 = createServiceManager({ dir, home, platform: 'linux', exec: r2.exec }).install({ node: '/n/bin/node' });
  assert.ok(res2.ok && res2.notes.some(n => /sudo loginctl enable-linger/.test(n)));
  // no systemd for this user: refused with the manual way
  const r3 = recorder({ 'systemctl --user --version': new Error('not available') });
  const res3 = createServiceManager({ dir: sandbox().dir, home, platform: 'linux', exec: r3.exec }).install({ node: '/n/bin/node' });
  assert.strictEqual(res3.ok, false); assert.match(res3.error, /mymaestro start/);
});

test('install on macOS: writes the plist and bootstraps it in the user\'s GUI domain', () => {
  const { home, dir } = sandbox();
  const r = recorder();
  const m = createServiceManager({ dir, home, platform: 'darwin', uid: 501, exec: r.exec });
  const res = m.install({ node: '/n/bin/node' });
  assert.strictEqual(res.ok, true);
  assert.ok(fs.existsSync(path.join(home, 'Library/LaunchAgents/ai.mymaestro.hub.plist')));
  assert.ok(r.calls.includes(`launchctl bootstrap gui/501 ${path.join(home, 'Library/LaunchAgents/ai.mymaestro.hub.plist')}`));
  assert.strictEqual(m.readInstall().service, 'launchd');
});

test('an install from before the installer is found by its unit\'s WorkingDirectory; state and remove use it', () => {
  const { home, dir } = sandbox();
  fs.mkdirSync(path.join(home, '.config/systemd/user'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/systemd/user/agent-hub-v5.service'), `[Service]\nWorkingDirectory=${dir}\nExecStart=/usr/bin/node server.js\n`);
  const r = recorder({ 'systemctl --user is-active': 'active\n', 'systemctl --user is-enabled': 'enabled\n' });
  const m = createServiceManager({ dir, home, platform: 'linux', exec: r.exec });
  assert.deepStrictEqual(m.detect(), { kind: 'systemd', unit: 'agent-hub-v5.service' });
  const st = m.state();
  assert.strictEqual(st.active, true); assert.strictEqual(st.enabled, true);
  m.remove();
  assert.ok(r.calls.includes('systemctl --user disable --now agent-hub-v5.service'));
  assert.ok(!fs.existsSync(path.join(home, '.config/systemd/user/agent-hub-v5.service')));
});

test('a broken link among the user\'s units (a removed service) does not hide the hub\'s unit; same for LaunchAgents', () => {
  const { home, dir } = sandbox();
  const units = path.join(home, '.config/systemd/user');
  fs.mkdirSync(units, { recursive: true });
  fs.symlinkSync('/nonexistent/aaa-removed.service', path.join(units, 'aaa-removed.service'));
  fs.writeFileSync(path.join(units, 'zzz-hub.service'), `[Service]\nWorkingDirectory=${dir}\nExecStart=/usr/bin/node ${path.join(dir, 'server.js')}\n`);
  const r = recorder({});
  assert.deepStrictEqual(createServiceManager({ dir, home, platform: 'linux', exec: r.exec }).detect(), { kind: 'systemd', unit: 'zzz-hub.service' });
  const agents = path.join(home, 'Library/LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  fs.symlinkSync('/nonexistent/aaa.plist', path.join(agents, 'aaa.plist'));
  fs.writeFileSync(path.join(agents, 'zzz.hub.plist'), `<plist><string>${path.join(dir, 'server.js')}</string></plist>`);
  assert.deepStrictEqual(createServiceManager({ dir, home, platform: 'darwin', exec: r.exec }).detect(), { kind: 'launchd', label: 'zzz.hub' });
});

test('the mymaestro command: help and version run, and every command named in the help exists', () => {
  const { execFileSync } = require('child_process');
  const cli = path.join(__dirname, '..', 'scripts', 'hub-cli.js');
  assert.match(execFileSync(process.execPath, [cli, 'version'], { encoding: 'utf8' }), /^My Maestro AI \d+\.\d+\.\d+ /);
  const help = execFileSync(process.execPath, [cli, 'help'], { encoding: 'utf8' });
  for (const c of ['status', 'start | stop | restart', 'logs', 'open', 'setup-link', 'update', 'doctor', 'backup', 'reset-2fa', 'service install', 'uninstall']) assert.ok(help.includes(`mymaestro ${c}`), c);
  const src = fs.readFileSync(cli, 'utf8');
  for (const c of ['status', 'start', 'stop', 'restart', 'logs', 'open', "'setup-link'", 'update', 'doctor', 'backup', "'reset-2fa'", 'service', 'uninstall', 'version']) assert.match(src, new RegExp(`^  (async )?${c.replace(/'/g, "'")}\\(\\)`, 'm'), c);
  assert.match(src, /if \(flag\('--plain'\)\) \{ if \(link\) out\(link\); return; \}/, 'the installer reads just the link');
});

test('mymaestro start (and the installer, which uses it) passes an allow-listed environment: no provider keys, tokens, HUB_* or CLAUDE_CODE_* from the caller', () => {
  const { home, dir } = sandbox();
  let spawned = null;
  const caller = { PATH: '/usr/bin:/bin', HOME: home, USER: 'eric', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TMPDIR: '/tmp/', TZ: 'America/New_York', HTTPS_PROXY: 'http://proxy:3128',
    OPENAI_API_KEY: 'sk-real', GEMINI_API_KEY: 'g-real', FOO_API_KEY: 'x', ANTHROPIC_API_KEY: 'a', GITHUB_TOKEN: 'ghp', HUB_AGENT_PERMISSION_MODE: 'bypassPermissions', HUB_WORKER_DEFAULT_SCOPE: 'full',
    HUB_HOME: '/live/hub-home', PORT: '8888', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDECODE: '1', XPC_SERVICE_NAME: 'com.agent-hub', INVOCATION_ID: 'i', NODE_OPTIONS: '--require /x.js', SSH_AUTH_SOCK: '/s' };
  const m = createServiceManager({ dir, home, platform: 'darwin', uid: 501, exec: recorder().exec, env: caller, spawn: (cmd, args, o) => { spawned = { cmd, args, o }; return { pid: 4321, unref() {} }; } });
  const r = m.start({ node: '/n/bin/node' });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.pid, 4321);
  assert.deepStrictEqual(spawned.o.env, { PATH: '/usr/bin:/bin', HOME: home, USER: 'eric', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TMPDIR: '/tmp/', TZ: 'America/New_York', HTTPS_PROXY: 'http://proxy:3128' });
  for (const k of Object.keys(startEnv(process.env))) assert.ok(!/KEY|TOKEN|SECRET|PASSWORD|^HUB_|^CLAUDE/.test(k), k);
});

test('the service files carry their own short environment, not the caller\'s', () => {
  const plist = renderLaunchdPlist({ dir: '/opt/hub', node: '/n/bin/node', home: '/home/u' });
  const unit = renderSystemdUnit({ dir: '/opt/hub', node: '/n/bin/node', home: '/home/u' });
  const keys = [...plist.matchAll(/<key>([A-Z_]+)<\/key><string>/g)].map(m => m[1]);
  assert.deepStrictEqual(keys, ['PATH', 'HOME', 'NODE_ENV']);
  assert.deepStrictEqual([...unit.matchAll(/^Environment=([A-Z_]+)=/gm)].map(m => m[1]), ['PATH', 'HOME', 'NODE_ENV']);
});

test('a second hub on this computer gets its own service name instead of replacing the first one\'s; a reinstall keeps its name', () => {
  const { home, dir } = sandbox();
  const other = path.join(path.dirname(dir), 'other-hub');
  const agents = path.join(home, 'Library/LaunchAgents'); fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'ai.mymaestro.hub.plist'), renderLaunchdPlist({ dir: other, node: '/n/bin/node', home }));
  const r = recorder();
  const m = createServiceManager({ dir, home, platform: 'darwin', uid: 501, exec: r.exec });
  const res = m.install({ node: '/n/bin/node' });
  assert.match(res.label, /^ai\.mymaestro\.hub\.[0-9a-f]{8}$/);
  assert.ok(!r.calls.includes('launchctl bootout gui/501/ai.mymaestro.hub'), 'the other hub\'s agent is left alone');
  assert.ok(fs.readFileSync(path.join(agents, 'ai.mymaestro.hub.plist'), 'utf8').includes(other), 'and its plist is not overwritten');
  assert.strictEqual(m.install({ node: '/n/bin/node' }).label, res.label, 'install.json keeps the name');
  // the hub that owns the default name keeps it
  assert.strictEqual(createServiceManager({ dir: other, home, platform: 'darwin', uid: 501, exec: recorder().exec }).serviceName('launchd'), 'ai.mymaestro.hub');
  // Linux: same rule for the unit
  const units = path.join(home, '.config/systemd/user'); fs.mkdirSync(units, { recursive: true });
  fs.writeFileSync(path.join(units, 'mymaestroai.service'), renderSystemdUnit({ dir: other, node: '/n/bin/node', home }));
  const { dir: dir2 } = sandbox();
  assert.match(createServiceManager({ dir: dir2, home, platform: 'linux', exec: recorder().exec }).serviceName('systemd'), /^mymaestroai-[0-9a-f]{8}\.service$/);
});

test('the hub set up before the installer (legacy com.agent-hub: node server.js run in its WorkingDirectory) is found as this folder\'s, and only by its own folder', () => {
  const { home, dir } = sandbox();
  const agents = path.join(home, 'Library/LaunchAgents'); fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'com.agent-hub.plist'), `<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n\t<key>Label</key>\n\t<string>com.agent-hub</string>\n\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>/n/bin/node</string>\n\t\t<string>server.js</string>\n\t</array>\n\t<key>WorkingDirectory</key>\n\t<string>${dir}</string>\n</dict>\n</plist>\n`);
  assert.deepStrictEqual(createServiceManager({ dir, home, platform: 'darwin', exec: recorder().exec }).detect(), { kind: 'launchd', label: 'com.agent-hub' });
  assert.deepStrictEqual(createServiceManager({ dir: dir + '-test', home, platform: 'darwin', exec: recorder().exec }).detect(), { kind: 'none' }, 'a folder whose path starts the same is not it');
});
