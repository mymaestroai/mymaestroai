'use strict';
// lib/service-manager: the systemd user unit / launchd agent that keeps My Maestro AI running, used by the installer
// and the mymaestro command. Commands are recorded, never run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
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
  // kept: the user's SSH agent (git over SSH for Update) and where the Claude and Codex sign-ins live: paths, not secrets
  assert.deepStrictEqual(spawned.o.env, { PATH: '/usr/bin:/bin', HOME: home, USER: 'eric', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TMPDIR: '/tmp/', TZ: 'America/New_York', HTTPS_PROXY: 'http://proxy:3128', SSH_AUTH_SOCK: '/s' });
  assert.deepStrictEqual(startEnv({ CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDECODE: '1' }), { CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x' });
  for (const k of Object.keys(startEnv(process.env))) assert.ok(!/KEY|TOKEN|SECRET|PASSWORD|^HUB_/.test(k) && (!/^CLAUDE/.test(k) || k === 'CLAUDE_CONFIG_DIR'), k);
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

test('envNotices: a provider key, PORT or HUB_HOME only the shell had is named (never its value); silent when the hub\'s Settings or .env has it', () => {
  const { envNotices } = require('../lib/service-manager');
  const { dir } = sandbox();
  const shell = { PATH: '/usr/bin', HOME: '/h', OPENAI_API_KEY: 'sk-secret-value-1', GEMINI_API_KEY: 'g-secret-value-2', BRAVE_SEARCH_API_KEY: 'b-secret-3', PORT: '9999', HUB_HOME: '/shared/x', HUB_AGENT_PERMISSION_MODE: 'bypassPermissions' };
  let n = envNotices({ env: shell, dir });
  const text = n.join('\n');
  assert.match(text, /Your OpenAI key \(OPENAI_API_KEY\) is only set in this shell\. My Maestro AI no longer passes your shell's settings to the hub, so it won't see it: add the key in Settings → LLM Providers\./);
  assert.match(text, /Your Gemini key \(GEMINI_API_KEY\)/); assert.match(text, /Your Brave Search key \(BRAVE_SEARCH_API_KEY\).*Settings → Web search/);
  assert.match(text, /Your shell sets PORT\..*put PORT=<port> in .*\.env/); assert.match(text, /Your shell sets HUB_HOME\./);
  for (const v of ['sk-secret-value-1', 'g-secret-value-2', 'b-secret-3', '9999', '/shared/x']) assert.ok(!text.includes(v), `never prints a value (${v})`);
  assert.ok(!/HUB_AGENT_PERMISSION_MODE|PATH|HOME\)/.test(text), 'only keys, PORT and HUB_HOME are worth a notice');
  // the hub has them itself: Settings for keys, .env for anything
  fs.writeFileSync(path.join(dir, 'data', 'settings.json'), JSON.stringify({ providers: { openai: { apiKey: 'saved' } }, webSearch: { keys: { brave: 'saved' } } }));
  fs.writeFileSync(path.join(dir, '.env'), '# comment\nPORT=8890\nGEMINI_API_KEY=in-env-file\nHUB_HOME=\n');
  n = envNotices({ env: shell, dir });
  assert.deepStrictEqual(n.map(l => l.match(/\(([A-Z_]+)\)|sets ([A-Z_]+)/).slice(1).find(Boolean)), ['HUB_HOME'], 'an empty HUB_HOME= line in .env provides nothing');
  assert.deepStrictEqual(envNotices({ env: { PATH: '/usr/bin' }, dir }), [], 'nothing from the shell: nothing to say');
  const sm = require('../lib/service-manager'); const st = require('../lib/settings');
  assert.deepStrictEqual(sm.ENV_KEY_MAP, st.ENV_KEY_MAP, 'the copy of the provider key names matches lib/settings.js');
  assert.deepStrictEqual(sm.SEARCH_ENV_KEY_MAP, st.SEARCH_ENV_KEY_MAP, 'and the web-search ones');
});

test('mymaestro start returns the notices and the CLI prints them; restart.sh prints them before its own start', () => {
  const { home, dir } = sandbox();
  const m = createServiceManager({ dir, home, platform: 'darwin', uid: 501, exec: recorder().exec, env: { PATH: '/usr/bin', OPENAI_API_KEY: 'sk-x' }, spawn: () => ({ pid: 1, unref() {} }) });
  const r = m.start({ node: '/n/bin/node' });
  assert.strictEqual(r.notices.length, 1); assert.match(r.notices[0], /OPENAI_API_KEY/); assert.ok(!r.notices[0].includes('sk-x'));
  const cli = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'hub-cli.js'), 'utf8');
  assert.match(cli, /async start\(\) \{\n\s+const r = svc\(\)\.start\(\);[^\n]*\n\s+for \(const n of r\.notices \|\| \[\]\) out\(`Note: \$\{n\}`\);/);
  const rs = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'restart.sh'), 'utf8');
  assert.ok(rs.indexOf('envNotices') > 0 && rs.indexOf('envNotices') < rs.indexOf('nohup env -i'), 'notices before the clean start');
});

test('a service file is matched to its folder through symlinks, either way round', () => {
  const { runsFolder } = require('../lib/service-manager');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'svc-link-')));
  const real = path.join(root, 'real'); fs.mkdirSync(real); const link = path.join(root, 'link'); fs.symlinkSync(real, link);
  assert.strictEqual(runsFolder(renderLaunchdPlist({ dir: link, node: '/n' }), real), true, 'plist names the link, the hub sees the real folder');
  assert.strictEqual(runsFolder(renderLaunchdPlist({ dir: real, node: '/n' }), link), true);
  assert.strictEqual(runsFolder(renderSystemdUnit({ dir: link, node: '/n' }), real), true);
  assert.strictEqual(runsFolder(renderLaunchdPlist({ dir: real, node: '/n' }), path.join(root, 'other')), false);
});

test('restart.sh run through a symlinked install folder restarts that hub instead of refusing it', { timeout: 60000 }, async (t) => {
  const { execFileSync, spawnSync } = require('child_process');
  const haveLsof = spawnSync('sh', ['-c', 'command -v lsof'], { encoding: 'utf8' }).stdout.trim();
  if (!haveLsof && !fs.existsSync('/proc/self/cwd')) return t.skip('neither lsof nor /proc to find the listener');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rs-link-')));
  const real = path.join(root, 'hub'); const link = path.join(root, 'hub-link');
  fs.mkdirSync(path.join(real, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(real, 'lib')); fs.mkdirSync(path.join(root, 'home'));
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'restart.sh'), path.join(real, 'scripts', 'restart.sh'));
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
  fs.writeFileSync(path.join(real, '.env'), `PORT=${port}\n`);
  // a stand-in hub: answers on the .env port, from its own folder
  fs.writeFileSync(path.join(real, 'server.js'), "const p=require('fs').readFileSync(__dirname+'/.env','utf8').match(/PORT=(\\d+)/)[1]; require('http').createServer((q,r)=>r.end('ok')).listen(+p,'127.0.0.1');\n");
  fs.symlinkSync(real, link);
  const first = require('child_process').spawn(process.execPath, ['server.js'], { cwd: real, detached: true, stdio: 'ignore' }); first.unref();
  const pids = [first.pid];
  t.after(() => { for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch {} } });
  for (let i = 0; i < 50; i++) { try { execFileSync('curl', ['-s', '-m', '1', `http://127.0.0.1:${port}/`]); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: path.join(root, 'home') };
  const r = spawnSync('bash', [path.join(link, 'scripts', 'restart.sh')], { env, encoding: 'utf8', timeout: 45000 });
  const pidNow = Number(fs.readFileSync(path.join(real, '.server.pid'), 'utf8').trim() || 0); if (pidNow) pids.push(pidNow);
  assert.ok(!/Not touching it/.test(r.stdout + r.stderr), r.stdout + r.stderr);
  assert.match(r.stdout, /Server started/, r.stdout + r.stderr);
  assert.notStrictEqual(pidNow, first.pid);
});

test('a service file is this folder\'s only when every server.js it runs is this folder\'s: a working directory alone proves nothing', () => {
  const { runsFolder } = require('../lib/service-manager');
  const a = '/srv/hub-a'; const b = '/srv/hub-b';
  // the working directory says A, the command runs B's server: B's service, not A's
  const unitAB = `[Service]\nWorkingDirectory=${a}\nExecStart=/usr/bin/node ${b}/server.js\n`;
  assert.strictEqual(runsFolder(unitAB, a), false); assert.strictEqual(runsFolder(unitAB, b), true);
  const plistAB = `<?xml version="1.0"?>\n<plist version="1.0"><dict><key>ProgramArguments</key><array><string>/n/node</string><string>${b}/server.js</string></array><key>WorkingDirectory</key><string>${a}</string></dict></plist>\n`;
  assert.strictEqual(runsFolder(plistAB, a), false); assert.strictEqual(runsFolder(plistAB, b), true);
  // the usual wrappers: nvm through bash, a relative server.js in the working directory, the path inside quotes
  assert.strictEqual(runsFolder(`[Service]\nWorkingDirectory=${a}\nExecStart=/bin/bash -lc 'source ~/.nvm/nvm.sh && node server.js'\n`, a), true);
  assert.strictEqual(runsFolder(`[Service]\nExecStart=/bin/bash -lc "exec node ${a}/server.js"\n`, a), true);
  assert.strictEqual(runsFolder(`[Service]\nWorkingDirectory=-${a}\nExecStart=/usr/bin/env node server.js --port 8888\n`, a), true);
  // can't tell, or not a hub: not this folder's
  assert.strictEqual(runsFolder(`[Service]\nExecStart=/usr/bin/node server.js\n`, a), false, 'a relative server.js with no working directory');
  assert.strictEqual(runsFolder(`[Service]\nWorkingDirectory=${a}\nExecStart=/usr/bin/node other-server.js\n`, a), false);
  assert.strictEqual(runsFolder(`[Service]\nWorkingDirectory=${a}\nExecStart=/usr/bin/node ${a}/server.js\nExecStart=/usr/bin/node ${b}/server.js\n`, a), false, 'a file that also runs another hub');
  assert.strictEqual(runsFolder(`[Service]\nWorkingDirectory=${a}\nExecStart=/usr/bin/node ${a}/server.js.bak\n`, a), false);
});

test('a reinstall keeps the service already running this folder under any name, rather than adding a second one', () => {
  const { home, dir } = sandbox();
  const units = path.join(home, '.config/systemd/user'); fs.mkdirSync(units, { recursive: true });
  fs.writeFileSync(path.join(units, 'agent-hub-v5.service'), `[Service]\nWorkingDirectory=${dir}\nExecStart=/usr/bin/node server.js\n`);
  const r = recorder();
  const m = createServiceManager({ dir, home, platform: 'linux', exec: r.exec });
  assert.strictEqual(m.serviceName('systemd'), 'agent-hub-v5.service');
  const res = m.install({ node: '/n/bin/node' });
  assert.strictEqual(res.unit, 'agent-hub-v5.service');
  assert.ok(!fs.existsSync(path.join(units, 'mymaestroai.service')), 'no second unit for the same hub');
  assert.ok(r.calls.includes('systemctl --user restart agent-hub-v5.service'));
  // macOS: the legacy com.agent-hub agent of this folder, with no data/install.json
  const { home: h2, dir: d2 } = sandbox();
  const agents = path.join(h2, 'Library/LaunchAgents'); fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'com.agent-hub.plist'), `<?xml version="1.0"?>\n<plist version="1.0"><dict><key>Label</key><string>com.agent-hub</string><key>ProgramArguments</key><array><string>/n/bin/node</string><string>server.js</string></array><key>WorkingDirectory</key><string>${d2}</string></dict></plist>\n`);
  const r2 = recorder();
  const res2 = createServiceManager({ dir: d2, home: h2, platform: 'darwin', uid: 501, exec: r2.exec }).install({ node: '/n/bin/node' });
  assert.strictEqual(res2.label, 'com.agent-hub');
  assert.ok(!fs.existsSync(path.join(agents, 'ai.mymaestro.hub.plist')), 'no second agent for the same hub');
});

test('restart.sh inside a systemd unit restarts the unit only when the server is that unit\'s own process; otherwise the server by itself', { timeout: 120000 }, async (t) => {
  const { execFileSync, spawnSync } = require('child_process');
  let cg = ''; try { cg = fs.readFileSync('/proc/self/cgroup', 'utf8'); } catch { /* no /proc */ }
  const unit = (cg.match(/[\w@.:-]+\.service/g) || []).filter(u => !/^user@\d+\.service$/.test(u)).pop();
  if (!unit) return t.skip('not running inside a systemd unit');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rs-unit-')));
  // a stand-in systemctl first on PATH: answers MainPID from a file (no file: no bus), records every call; the real one is never run
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin); fs.mkdirSync(path.join(root, 'home'));
  const calls = path.join(root, 'systemctl.log'); const main = path.join(root, 'main');
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >> '${calls}'\ncase "$*" in *show*) [ -f '${main}' ] || exit 1; echo "MainPID=$(cat '${main}')" ;; esac\nexit 0\n`, { mode: 0o755 });
  const hub = path.join(root, 'hub');
  fs.mkdirSync(path.join(hub, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(hub, 'lib'));
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'restart.sh'), path.join(hub, 'scripts', 'restart.sh'));
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close((e) => e ? reject(e) : resolve(port)); }); });
  fs.writeFileSync(path.join(hub, '.env'), `PORT=${port}\n`);
  fs.writeFileSync(path.join(hub, 'server.js'), "const p=require('fs').readFileSync(__dirname+'/.env','utf8').match(/PORT=(\\d+)/)[1]; require('http').createServer((q,r)=>r.end('ok')).listen(+p,'127.0.0.1');\n");
  const pids = [];
  const killAll = async () => { for (const p of pids.splice(0)) { try { process.kill(p, 'SIGKILL'); } catch {} } await new Promise(res => setTimeout(res, 300)); };
  t.after(killAll);
  const up = async () => { for (let i = 0; i < 50; i++) { try { execFileSync('curl', ['-s', '-m', '1', `http://127.0.0.1:${port}/`]); return; } catch { await new Promise(r => setTimeout(r, 100)); } } };
  // a hub started by hand inside this unit: a child of this test, in its cgroup
  const startStandIn = async () => { const c = require('child_process').spawn(process.execPath, ['server.js'], { cwd: hub, detached: true, stdio: 'ignore' }); c.unref(); pids.push(c.pid); await up(); return c.pid; };
  const restartSh = (mainPid) => {
    fs.writeFileSync(calls, '');
    if (mainPid === null) { try { fs.unlinkSync(main); } catch { /* none */ } } else fs.writeFileSync(main, `${mainPid}\n`);
    const r = spawnSync('bash', [path.join(hub, 'scripts', 'restart.sh')], { env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: path.join(root, 'home') }, encoding: 'utf8', timeout: 45000 });
    let now = 0; try { now = Number(fs.readFileSync(path.join(hub, '.server.pid'), 'utf8').trim()); } catch { /* none */ }
    if (now) pids.push(now);
    return { out: r.stdout + r.stderr, calls: fs.readFileSync(calls, 'utf8'), now };
  };
  const restartedUnit = (c) => / restart /.test(` ${c} `);
  // the unit's process is another one (the hub whose agent started this one): the unit is left alone
  await startStandIn();
  let r = restartSh(1);
  assert.ok(!restartedUnit(r.calls), `the unit is never restarted: ${r.calls}`);
  assert.match(r.out, /not that unit's own process/, r.out);
  assert.match(r.out, /Server started/, r.out);
  // the restarted server, left behind when restart.sh exited, has been adopted: with no bus to ask, the unit is still
  // never restarted (only that one server may be asked to exit)
  const adopted = r.now;
  r = restartSh(null);
  assert.ok(!restartedUnit(r.calls), `no bus: never a unit restart on a guess: ${r.calls}`);
  await killAll();
  try { process.kill(adopted, 0); pids.push(adopted); } catch { /* gone */ }
  await killAll();
  // no bus, and the server's parent is this test, not systemd: the server restarts by itself
  await startStandIn();
  r = restartSh(null);
  assert.ok(!restartedUnit(r.calls), r.calls);
  assert.match(r.out, /Server started/, r.out);
  await killAll();
  // the server is the unit's own process: systemd restarts the unit, nothing is killed here
  const standIn = await startStandIn();
  r = restartSh(standIn);
  assert.match(r.calls, new RegExp(`restart ${unit.replace(/[.]/g, '\\.')}`), r.calls);
  assert.match(r.out, /Service restarted by systemd/, r.out);
  assert.doesNotThrow(() => process.kill(standIn, 0), 'the server itself was not killed here');
});
