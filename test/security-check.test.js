'use strict';
// Security check (lib/security-check): the hub reviews its own security configuration. Fake dependencies describe
// a badly set-up, network-exposed install and a clean one; the parsers get real command output; fixModes works on
// a temp dir; the terminal script runs with no hub; source pins cover the routes, the Settings box and the banner.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
// lib/ and scripts/security-check.js come from a throwaway install, so nothing under the real data/ is touched.
const ISO = makeIsolatedInstall('security-check-iso-', { copy: ['scripts/security-check.js'] });
const sc = require(path.join(ISO.lib, 'security-check'));

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const byId = (r, id) => r.items.find(i => i.id === id);
const modeStat = (modes) => (p) => (p in modes ? { mode: modes[p] | (modes[p] >= 0o40000 ? 0 : 0o100000), uid: 1000, isDir: !!(modes[p] & 0o40000), mtimeMs: 0 } : null);
const D = 0o40000;   // directory bit for the fake stat

const BAD = {
  platform: 'linux', installDir: '/h/hub', dataDir: '/h/hub/data', hubHome: '/h', homeDir: '/home/x',
  env: { HUB_AUTH_USERNAME: 'a', HUB_AUTH_PASSWORD: 'b', HUB_AGENT_PERMISSION_MODE: 'bypassPermissions' },
  port: 8888, host: '0.0.0.0', exposed: () => true,
  hasUsers: () => false, listUsers: () => [],
  listTokens: () => [{ id: 't1', name: 'remote-bot', scopes: ['chat'], loopbackOnly: false, expiresAt: null }],
  agents: async () => [
    { name: 'maestro', lead: true, model: 'claude-sdk/claude-x' },
    { name: 'kid', owner: 'u1', sandbox: 'off', model: 'claude-sdk/claude-x' },
    { name: 'bot', model: 'claude-sdk/claude-x', policy: { overrides: { destroy: 'allow' }, roots: ['/h/hub'] } },
  ],
  isMemberOwned: (a) => a.owner === 'u1',
  getSetting: (k) => ({ sandboxDefaults: { member: 'container', admin: 'off' }, toolsDefault: 'client', webFetch: { allowPrivate: 'all' } })[k],
  rootGrants: () => [{ agent: 'bot', until: '2030-01-01T00:00:00Z', by: 'owner' }],
  stat: modeStat({ '/h/hub/.env': 0o644, '/h/hub/data': D | 0o755, '/h/hub/data/settings.json': 0o640, '/h/hub/workspaces': D | 0o755, '/home/x/.ssh/id_ed25519': 0o644 }),
  readdir: (p) => (p === '/home/x/.ssh' ? ['id_ed25519', 'id_ed25519.pub'] : p === '/h/hub' ? ['backup-2026.tar.gz', 'server.js'] : []),
  listeners: async () => [{ addr: '0.0.0.0', port: 11434, iface: 'all' }, { addr: '0.0.0.0', port: 22, iface: 'all' }, { addr: '127.0.0.1', port: 8888, iface: 'loopback' }],
  tailscale: async () => [{ url: 'https://box.ts.net', funnel: true, target: { raw: 'http://127.0.0.1:8888', port: 8888 } }],
  sshdConfig: async () => 'PasswordAuthentication yes\nPermitRootLogin yes\n',
  sudoStatus: async () => ({ nopasswd: true }), dockerGroup: async () => ({ inGroup: true, rootless: false }),
  sandboxStatus: async () => ({ docker: false, imageReady: false, containers: [] }),
  git: async () => ({ branch: 'main', dirty: ['server.js'], tracked: ['.env'], historySecrets: [], fetchAgeDays: 45 }),
  hubStartedAt: () => new Date('2026-10-17T10:00:00Z'), codeNewestMtime: () => new Date('2026-10-17T12:00:00Z'),
  nodeVersion: 'v18.20.0', publicAddress: () => '203.0.113.5', pushEndpoints: () => ['evil.example.net'],
  lockfilePresent: () => false, backupTimers: async () => [], otherAccounts: async () => 2,
  unitInfo: async () => ({ kind: 'systemd-user', unit: 'agent-hub.service', noNewPrivileges: false }),
  now: () => new Date('2026-10-17T13:00:00Z'), log: () => {},
};

test('a badly set-up, network-exposed install: every big hole is critical, each item says what to do', async () => {
  const r = await sc.createSecurityCheck(BAD).check();
  assert.strictEqual(byId(r, 'accounts').level, 'critical');
  assert.deepStrictEqual(byId(r, 'accounts').action, { label: 'Create the admin account', href: '/welcome' });
  assert.strictEqual(byId(r, 'legacy-login').level, 'warn');
  assert.strictEqual(byId(r, 'bind').level, 'critical', 'exposed with no two-factor admin');
  assert.strictEqual(byId(r, 'tailscale').level, 'critical', 'Funnel points at the hub');
  assert.strictEqual(byId(r, 'file-modes').level, 'critical', '.env world-readable');
  assert.match(byId(r, 'file-modes').detail, /\.env is 644/);
  assert.deepStrictEqual(byId(r, 'file-modes').action, { label: 'Tighten them now', api: '/api/security-check/fix-modes', method: 'POST' });
  assert.strictEqual(byId(r, 'private-folders').level, 'warn', 'other accounts exist, so world-readable agent folders are a warning');
  assert.strictEqual(byId(r, 'home-secrets').level, 'warn');
  assert.match(byId(r, 'home-secrets').detail, /id_ed25519 \(SSH private key, mode 644\)/);
  assert.match(byId(r, 'stray-archives').detail, /backup-2026\.tar\.gz/);
  assert.strictEqual(byId(r, 'git-secrets').level, 'critical');
  assert.strictEqual(byId(r, 'member-host').level, 'critical');
  assert.strictEqual(byId(r, 'policy-overrides').level, 'warn');
  assert.match(byId(r, 'policy-overrides').detail, /bot: destroy/);
  assert.strictEqual(byId(r, 'roots').level, 'info');
  assert.strictEqual(byId(r, 'approvals').level, 'warn', 'cards off while a non-lead agent has a host shell');
  assert.strictEqual(byId(r, 'webfetch-private').level, 'warn');
  assert.strictEqual(byId(r, 'permission-mode').level, 'warn');
  assert.strictEqual(byId(r, 'root-account').level, 'warn');
  assert.match(byId(r, 'root-account').detail, /sudo needs no password/);
  assert.match(byId(r, 'root-account').detail, /docker group/);
  assert.strictEqual(byId(r, 'root-reach').level, 'warn');
  assert.match(byId(r, 'root-reach').title, /^1 agent\(s\) besides the lead/);
  assert.strictEqual(byId(r, 'tokens-anyhost').level, 'warn');
  assert.strictEqual(byId(r, 'root-grants').level, 'info');
  assert.strictEqual(byId(r, 'lan-services-critical').level, 'critical', 'Ollama on all interfaces of a machine with a public address');
  assert.match(byId(r, 'lan-services-critical').detail, /Ollama on 0\.0\.0\.0:11434/);
  assert.match(byId(r, 'lan-services-critical').detail, /public address \(203\.0\.113\.5\)/);
  assert.match(byId(r, 'lan-other').detail, /SSH/);
  assert.strictEqual(byId(r, 'ssh').level, 'warn');
  assert.match(byId(r, 'ssh').title, /accepts passwords and allows root/);
  assert.strictEqual(byId(r, 'other-accounts').level, 'info');
  assert.strictEqual(byId(r, 'supervisor').level, 'info');
  assert.strictEqual(byId(r, 'backups').level, 'info');
  assert.strictEqual(byId(r, 'node').level, 'warn');
  assert.strictEqual(byId(r, 'restart-pending').level, 'warn');
  assert.strictEqual(byId(r, 'git-dirty').level, 'info');
  assert.strictEqual(byId(r, 'fetch-age').level, 'info');
  assert.strictEqual(byId(r, 'lockfile').level, 'warn');
  assert.strictEqual(byId(r, 'push-endpoints').level, 'warn');
  assert.ok(r.skipped.some(s => s.id === 'containers'), 'no Docker and nobody needs a container: skipped, not an alarm');
  assert.ok(r.critical >= 7, `critical count ${r.critical}`);
  for (const i of r.items) { assert.ok(i.title && i.group in sc.GROUPS, i.id); if (i.level !== 'ok') assert.ok(i.detail, `${i.id} has a detail`); }
});

test("gog's real sign-in folder is listed with the personal credentials, wherever the system keeps it", async () => {
  for (const [dir, env] of [['/home/x/.config/gogcli', {}], ['/home/x/Library/Application Support/gogcli', {}], ['/cfg/gogcli', { XDG_CONFIG_HOME: '/cfg' }]]) {
    const r = await sc.createSecurityCheck({ ...BAD, env: { ...BAD.env, ...env }, stat: modeStat({ [dir]: D | 0o700 }), readdir: () => [] }).check();
    assert.match(byId(r, 'home-secrets').detail, /Google sign-in \(gog\)/, dir);
  }
  const none = await sc.createSecurityCheck({ ...BAD, stat: modeStat({ '/home/x/.config/gog': D | 0o700 }), readdir: () => [] }).check();
  assert.strictEqual(byId(none, 'home-secrets'), undefined, 'a folder gog does not use is not reported');
});

test('a clean install reports nothing critical and no warnings', async () => {
  const r = await sc.createSecurityCheck({
    ...BAD, env: {}, host: '127.0.0.1', exposed: () => false,
    hasUsers: () => true, listUsers: () => [{ id: 'u0', login: 'owner@example.com', role: 'admin', totpEnabled: true }],
    listTokens: () => [{ id: 't1', name: 'bots', scopes: ['status'], loopbackOnly: true, expiresAt: '2030-01-01T00:00:00Z', lastUsed: '2026-10-17T00:00:00Z' }],
    agents: async () => [{ name: 'maestro', lead: true, model: 'claude-sdk/claude-x' }],
    getSetting: (k) => ({ sandboxDefaults: { member: 'container', admin: 'container' }, toolsDefault: 'hub', approvalClasses: ['sudo', 'money'], webFetch: { allowPrivate: 'none' } })[k],
    rootGrants: () => [], stat: modeStat({ '/h/hub/.env': 0o600, '/h/hub/data': D | 0o700 }), readdir: () => [],
    listeners: async () => [{ addr: '127.0.0.1', port: 8888, iface: 'loopback' }, { addr: '100.100.1.2', port: 443, iface: 'tailnet' }, { addr: '100.100.1.2', port: 22, iface: 'tailnet' }],
    tailscale: async () => [], tailscaleExtra: async () => ({ lockEnabled: true, keyExpiry: '2027-01-01T00:00:00Z' }),
    sshdConfig: async () => 'PasswordAuthentication no\nPermitRootLogin prohibit-password\n',
    sudoStatus: async () => ({ nopasswd: false }), dockerGroup: async () => ({ inGroup: false, rootless: false }),
    sandboxStatus: async () => ({ docker: true, imageReady: true, containers: [] }),
    git: async () => ({ branch: 'main', dirty: [], tracked: [], historySecrets: [], fetchAgeDays: 2 }),
    hubStartedAt: () => new Date('2026-10-17T12:30:00Z'), codeNewestMtime: () => new Date('2026-10-17T12:00:00Z'),
    nodeVersion: 'v22.23.5', publicAddress: () => null, pushEndpoints: () => ['fcm.googleapis.com'], lockfilePresent: () => true,
    backupTimers: async () => ['hub-backup.timer'], otherAccounts: async () => 0, unitInfo: async () => ({ kind: 'systemd-system', unit: 'agent-hub.service', noNewPrivileges: true }),
  }).check();
  assert.strictEqual(r.critical, 0, JSON.stringify(r.items.filter(i => i.level === 'critical').map(i => i.id)));
  assert.strictEqual(r.warnings, 0, JSON.stringify(r.items.filter(i => i.level === 'warn').map(i => i.id)));
  for (const id of ['accounts', 'bind', 'tailscale', 'file-modes', 'git-secrets', 'lead', 'policy-overrides', 'approvals', 'containers', 'tokens', 'root-account', 'root-grants', 'lan-services', 'ssh', 'backups', 'node', 'restart-pending', 'git', 'supervisor']) {
    assert.strictEqual(byId(r, id) && byId(r, id).level, 'ok', id);
  }
  assert.ok(r.items.every(i => i.level !== 'critical' || i.action), 'critical items carry an action when there is a page for it');
});

test('parsers: listeners, Tailscale serve/funnel text, cloudflared ingress, sshd keywords, versions', () => {
  assert.deepStrictEqual(sc.parseListener('0.0.0.0:22'), { addr: '0.0.0.0', port: 22, iface: 'all' });
  assert.deepStrictEqual(sc.parseListener('[::]:445'), { addr: '::', port: 445, iface: 'all' });
  assert.deepStrictEqual(sc.parseListener('*:3389'), { addr: '*', port: 3389, iface: 'all' });
  assert.deepStrictEqual(sc.parseListener('127.0.0.53%lo:53'), { addr: '127.0.0.53', port: 53, iface: 'loopback' });
  assert.deepStrictEqual(sc.parseListener('100.64.0.10:443'), { addr: '100.64.0.10', port: 443, iface: 'tailnet' });
  assert.deepStrictEqual(sc.parseListener('[fd7a:115c:a1e0::1]:8443'), { addr: 'fd7a:115c:a1e0::1', port: 8443, iface: 'tailnet' });
  assert.deepStrictEqual(sc.parseListener('192.168.1.5:8080'), { addr: '192.168.1.5', port: 8080, iface: 'lan' });
  assert.strictEqual(sc.parseListener('garbage'), null);
  const serve = 'https://box.example.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:8080\n\nhttps://box.example.ts.net:8443 (Funnel on)\n|-- / proxy http://127.0.0.1:8443\n';
  assert.deepStrictEqual(sc.parseTailscaleServe(serve), [
    { url: 'https://box.example.ts.net', funnel: false, target: { raw: 'http://127.0.0.1:8080', port: 8080 } },
    { url: 'https://box.example.ts.net:8443', funnel: true, target: { raw: 'http://127.0.0.1:8443', port: 8443 } },
  ]);
  const yml = 'tunnel: abc\ncredentials-file: /etc/cloudflared/abc.json\ningress:\n  - hostname: hooks.example.com\n    service: http://127.0.0.1:8899\n  - service: http_status:404\n';
  assert.deepStrictEqual(sc.parseTunnelConfig(yml), [{ hostname: 'hooks.example.com', service: 'http://127.0.0.1:8899' }, { hostname: null, service: 'http_status:404' }]);
  assert.deepStrictEqual(sc.parseTunnelConfig('ingress:\n  - service: http_status:404\n'), [{ hostname: null, service: 'http_status:404' }]);
  assert.strictEqual(sc.sshdValue('# PasswordAuthentication no\nPasswordAuthentication yes\n', 'PasswordAuthentication'), 'yes');
  assert.strictEqual(sc.sshdValue('Include /etc/ssh/sshd_config.d/*.conf\nKbdInteractiveAuthentication no\n', 'PasswordAuthentication'), null);
  assert.strictEqual(sc.versionBelow('v22.23.1', '22.23.2'), true);
  assert.strictEqual(sc.versionBelow('v22.23.2', '22.23.2'), false);
  assert.strictEqual(sc.versionBelow('v24.0.0', '22.23.2'), false);
  assert.strictEqual(sc.ifaceOf('::'), 'all');
});

test('fixModes tightens only the loose secret files (600 / 700) and run() stores a private result', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-'));
  const data = path.join(tmp, 'data');
  fs.mkdirSync(data, { mode: 0o755 }); fs.chmodSync(data, 0o755);
  fs.writeFileSync(path.join(tmp, '.env'), 'PORT=1\n', { mode: 0o644 }); fs.chmodSync(path.join(tmp, '.env'), 0o644);
  fs.writeFileSync(path.join(data, 'settings.json'), '{}', { mode: 0o600 }); fs.chmodSync(path.join(data, 'settings.json'), 0o600);
  const c = sc.createSecurityCheck({ ...BAD, installDir: tmp, dataDir: data, hubHome: path.join(tmp, 'home'), homeDir: path.join(tmp, 'nohome'), stat: undefined, readdir: () => [], git: async () => null, log: () => {} });
  const loose = c.looseFiles().map(f => path.relative(tmp, f.p)).sort();
  assert.deepStrictEqual(loose, ['.env', 'data']);
  const fx = c.fixModes();
  assert.deepStrictEqual(fx.fixed.map(f => `${f.path}:${f.from}>${f.to}`).sort(), ['.env:644>600', 'data:755>700']);
  assert.strictEqual(fs.statSync(path.join(tmp, '.env')).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(data).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(path.join(data, 'settings.json')).mode & 0o777, 0o600, 'untouched');
  assert.deepStrictEqual(c.looseFiles(), []);
  const r = await c.run();
  const stored = JSON.parse(fs.readFileSync(path.join(data, 'security-check.json'), 'utf8'));
  assert.strictEqual(stored.checkedAt, r.checkedAt);
  assert.strictEqual(fs.statSync(path.join(data, 'security-check.json')).mode & 0o777, 0o600);
  const again = await c.latest({ maxAgeMs: 10 * 60 * 1000 });
  assert.strictEqual(again.cached, true, 'a fresh result is served from memory');
  assert.strictEqual(c.schedule(0), false, '0 hours = no schedule');
  assert.strictEqual(c.schedule(24, { firstDelayMs: 3600000 }), true); c.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the terminal script runs with no hub process and prints clean JSON', { timeout: 90000 }, () => {
  let stdout = '';
  let code = 0;
  try { stdout = execFileSync(process.execPath, [path.join(ISO.inst, 'scripts', 'security-check.js'), '--json'], { cwd: ISO.inst, env: { ...process.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 80000 }); }
  catch (e) { code = e.status; stdout = e.stdout || ''; }
  assert.ok([0, 1, 2].includes(code), `exit code ${code}`);
  const r = JSON.parse(stdout);
  assert.ok(Array.isArray(r.items) && r.items.length > 10);
  assert.ok(r.groups && r.groups.accounts);
  assert.strictEqual(code, r.critical ? 2 : r.warnings ? 1 : 0, 'exit code follows the counts');
});

test('wiring: routes, nightly schedule, Settings box, banner, docs, npm script', () => {
  const server = read('server.js'), app = read('app.js');
  for (const s of ["pathname === '/api/security-check' && req.method === 'GET'", "pathname === '/api/security-check/run' && req.method === 'POST'", "pathname === '/api/security-check/fix-modes' && req.method === 'POST'",
    "securityCheck().latest({ maxAgeMs: 60 * 60 * 1000 })", "securityCheck().schedule(process.env.HUB_SECURITY_CHECK_HOURS === undefined ? 24 : Number(process.env.HUB_SECURITY_CHECK_HOURS)",
    "events.publish('security_check'"]) assert.ok(server.includes(s), s);
  for (const s of ['id="st-sec-section"', 'async function loadSecurityCheck(runNow = false)', "fetch(runNow ? '/api/security-check/run' : '/api/security-check', init)", 'async function reviewRefresh()',
    "reviewRefresh().catch(() => {});   // a Run now that resolves or finds something updates the list, the count and the banner at once", "id = 'hub-review-banner'", "onclick=\"loadSecurityCheck(true)\">Run now</button>", 'node scripts/security-check.js']) assert.ok(app.includes(s), s);
  assert.ok(read('README.md').includes('## Security Check'));
  assert.ok(read('docs/HUB-MAP.md').includes('security-check.js'));
  assert.ok(JSON.parse(read('package.json')).scripts['security-check'] === 'node scripts/security-check.js');
});

// ── Node.js security releases (2026-11-11): the November releases, rated HIGH, make an older Node.js critical, and the
// fix names the right command for this install (the installer's own Node.js, or the computer's). ──
test('Node.js behind a HIGH-rated security release is critical, with the fix that fits the install', async () => {
  assert.deepStrictEqual(sc.NODE_FLOORS, { 22: '22.23.5', 24: '24.22.3', 26: '26.13.1' });
  assert.strictEqual(sc.NODE_SECURITY_RELEASE.rated, 'HIGH');
  const r = await sc.createSecurityCheck({ ...BAD, nodeVersion: 'v22.23.3' }).check();
  const n = byId(r, 'node');
  assert.strictEqual(n.level, 'critical');
  assert.match(n.title, /Node\.js v22\.23\.3 is missing security fixes rated HIGH \(fixed in 22\.23\.5\)/);
  assert.match(n.fix || '', /^To fix it, /);
  const ok = await sc.createSecurityCheck({ ...BAD, nodeVersion: 'v22.23.5' }).check();
  assert.strictEqual(byId(ok, 'node').level, 'ok');
});

test('nodeSecurity: installer-managed or the computer\'s own Node.js, branch, quoted folder, prereleases', () => {
  const m = sc.nodeSecurity({ nodeVersion: 'v22.23.3', execPath: '/home/u/.mymaestroai/node/bin/node', home: '/home/u', env: {}, root: "/home/u/My Hub's", platform: 'linux', branch: 'dev' });
  assert.strictEqual(m.behind, true);
  assert.strictEqual(m.managed, true);
  assert.ok(m.how.endsWith(`curl -fsSL https://mymaestroai.ai/install.sh | bash -s -- --yes --channel experimental --dir '/home/u/My Hub'\\''s'`), m.how);
  const stable = sc.nodeSecurity({ nodeVersion: 'v22.23.3', execPath: '/opt/mm/node/bin/node', home: '/home/u', env: { MM_STATE_DIR: '/opt/mm' }, root: '/home/u/mymaestroai', platform: 'linux', branch: 'main' });
  assert.strictEqual(stable.managed, true, 'MM_STATE_DIR moves the installer\'s Node.js');
  assert.ok(stable.how.endsWith("bash -s -- --yes --dir '/home/u/mymaestroai'"), stable.how);
  for (const branch of ['feature-x', null]) {
    const odd = sc.nodeSecurity({ nodeVersion: 'v22.23.3', execPath: '/home/u/.mymaestroai/node/bin/node', home: '/home/u', env: {}, root: '/home/u/mymaestroai', platform: 'linux', branch });
    assert.doesNotMatch(odd.how, /curl/, 'the installer would move this checkout to stable');
    assert.match(odd.how, /do not re-run it/);
  }
  const renamed = sc.nodeSecurity({ nodeVersion: 'v22.23.3', execPath: '/home/u/.mymaestroai/node/bin/node', home: '/home/u', env: { HUB_STABLE_BRANCH: 'stable' }, root: '/home/u/mymaestroai', platform: 'linux', branch: 'stable' });
  assert.match(renamed.how, /do not re-run it/, 'the installer knows only main and dev');
  const named = sc.nodeSecurity({ nodeVersion: 'v22.23.3', execPath: '/home/u/.mymaestroai/node/bin/node', home: '/home/u', env: {}, root: '/home/u/mymaestroai', platform: 'linux', branch: 'unknown' });
  assert.match(named.how, /this install is on the branch unknown/, 'a branch really named "unknown" is just another branch');
  const nogit = sc.nodeSecurity({ nodeVersion: 'v22.23.3', execPath: '/home/u/.mymaestroai/node/bin/node', home: '/home/u', env: {}, root: '/home/u/mymaestroai', platform: 'linux',
    lookupBranch: () => { const e = new Error('spawn git ENOENT'); e.code = 'ENOENT'; throw e; } });
  assert.match(nogit.how, /^git could not run here/);
  assert.doesNotMatch(nogit.how, /curl/);
  const detached = sc.nodeSecurity({ nodeVersion: 'v22.23.3', execPath: '/home/u/.mymaestroai/node/bin/node', home: '/home/u', env: {}, root: '/home/u/mymaestroai', platform: 'linux',
    lookupBranch: () => { const e = new Error('not a symbolic ref'); e.status = 1; throw e; } });
  assert.match(detached.how, /a detached checkout/);
  const sys = sc.nodeSecurity({ nodeVersion: 'v22.23.3', execPath: '/usr/bin/node', home: '/home/u', env: {}, platform: 'linux', branch: 'main' });
  assert.strictEqual(sys.managed, false);
  assert.match(sys.how, /sudo apt-get update && sudo apt-get install --only-upgrade nodejs/);
  assert.match(sys.how, /point the hub's service at that new Node\.js/);
  assert.match(sc.nodeSecurity({ nodeVersion: 'v22.23.3', execPath: '/opt/homebrew/bin/node', home: '/Users/u', env: {}, platform: 'darwin', branch: 'main' }).how, /brew upgrade node@22, or brew upgrade node; nvm: nvm install 22\.23\.5/);
  const b = (v) => sc.nodeSecurity({ nodeVersion: v, execPath: '/usr/bin/node', env: {}, branch: 'main' }).behind;
  assert.strictEqual(b('v22.23.5'), false);
  assert.strictEqual(b('v22.23.5-rc.1'), true, 'a prerelease of the fix is not the fix');
  assert.strictEqual(b('v22.24.0-rc.1'), false);
  assert.strictEqual(b('v24.22.0'), true);
  assert.strictEqual(b('v26.13.1'), false);
});

test('a Node.js line with no security floor (odd or end-of-life) is a warning, never ok', async () => {
  const r = await sc.createSecurityCheck({ ...BAD, nodeVersion: 'v25.1.0' }).check();
  assert.strictEqual(byId(r, 'node').level, 'warn');
  assert.match(byId(r, 'node').title, /no security support here/);
});

// P4-15: the security banner (critical bar, dismissible warning bar) is gone. A critical finding is a Fix now item in the one review banner,
// a warning is Worth doing (no banner, no count, nothing to dismiss). tests for the one banner: test/ui-review-tiers.test.js.
test('security banner is gone: critical findings feed the one banner, warnings are Worth doing and never dismissed', () => {
  const app = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
  for (const s of ['paintSecurityBanner', 'dismissSecurityBanner', 'hub-security-notice', 'sec-dismiss', 'SEC_DISMISS_KEY']) assert.ok(!app.includes(s), s);
  const R = require('../lib/ui-review.js');
  const r = R.build({ security: { items: [{ id: 'node', level: 'critical', title: 'Node.js misses fixes' }, { id: 'totp', level: 'warn', title: 'totp' }, { id: 'approvals', level: 'warn', title: 'approvals' }, { id: 'ok1', level: 'ok', title: 'fine' }] } });
  assert.deepStrictEqual(r.fix.map((p) => p.id), ['sec:node']);
  assert.deepStrictEqual(r.worth.map((p) => p.id).sort(), ['sec:approvals', 'sec:totp']);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(R.build({ security: { items: [{ id: 'totp', level: 'warn', title: 'totp' }] } }).count, 0, 'a warning alone never counts');
});

test('Run now in the security box reloads the review list, count and banner; the notice stack holds the phone-layout bar, the theme line and the one banner', () => {
  const app = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
  const i = app.indexOf('async function loadSecurityCheck(');
  assert.match(app.slice(i, app.indexOf('\n    }\n', i)), /reviewRefresh\(\)\.catch\(\(\) => \{\}\);/);
  const j = app.indexOf('function layoutBanners() {');
  const fn = new Function('document', app.slice(j, app.indexOf('\n    }\n', j) + 6) + '\nreturn layoutBanners;');
  const pushed = {};
  const page = (nodes, cached) => ({ getElementById: (id) => nodes[id] || null, documentElement: { classList: { contains: (c) => !!cached && c === 'mm-rvb-cached' }, style: { setProperty: (k, v) => { pushed[k] = v; }, getPropertyValue: (k) => (k === '--mm-rvb-h' && cached ? cached + 'px' : '') } } });
  const layout = { style: {}, offsetHeight: 30 }, theme = { style: {}, offsetHeight: 20 }, review = { style: {}, offsetHeight: 34 };
  fn(page({ 'hub-review-banner': review, 'hub-theme-notice': theme, 'hub-phone-layout-notice': layout }))();
  assert.deepStrictEqual([layout.style.top, theme.style.top, review.style.top], ['0px', '30px', '50px'], 'all three stack; none covers another');
  assert.strictEqual(pushed['--banner-h'], '84px', 'the page moves down by the whole stack, so the header stays clickable');
  fn(page({ 'hub-review-banner': review }))();
  assert.strictEqual(review.style.top, '0px');
  fn(page({}))();
  assert.strictEqual(pushed['--banner-h'], '0px', 'no notices: the page goes back up');
  // the review banner's reserved place (html.mm-rvb-cached) counts in the stack until the real bar takes it
  fn(page({ 'hub-theme-notice': theme }, 41))();
  assert.strictEqual(pushed['--banner-h'], '61px', 'the theme line plus the reserved place');
  fn(page({ 'hub-review-banner': review }, 41))();
  assert.strictEqual(pushed['--banner-h'], '34px', 'the real bar: the stand-in no longer counts');
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  for (const rule of [/padding-top: var\(--banner-h, 0px\)/, /\.sidebar-toggle \{\s*\n\s*display: none; position: fixed; top: calc\(10px \+ var\(--banner-h, 0px\)\)/, /position: fixed; left: -340px; top: var\(--banner-h, 0px\)/, /height: calc\(100dvh - var\(--banner-h, 0px\)\)/]) assert.match(html, rule);
});

// `sudo -n -l` as macOS and Linux print it. Only a passwordless rule that runs as root (ALL, root, #0) is a way to root.
const MAC_SUDO = `User epfleckl may run the following commands on Puffy-7:
    (ALL) ALL
    (maestrotest) NOPASSWD: ALL
`;
const LINUX_SUDO = (rules, defaults = 'env_reset, mail_badpass, secure_path=/usr/local/sbin\\:/usr/local/bin\\:/usr/sbin\\:/usr/bin') => `Matching Defaults entries for hub on box:
    ${defaults}

User hub may run the following commands on box:
${rules.map(r => `    ${r}`).join('\n')}
`;

test('parseSudoList: passwordless only as an unprivileged user is not a way to root; passwordless as ALL/root is, naming the commands', () => {
  assert.deepStrictEqual(sc.parseSudoList(MAC_SUDO), { nopasswd: false, rootCommands: [], otherUsers: ['maestrotest'] }, 'this Mac: root needs a password');
  assert.deepStrictEqual(sc.parseSudoList(LINUX_SUDO(['(ALL) NOPASSWD: ALL'])), { nopasswd: true, rootCommands: ['ALL'], otherUsers: [] });
  assert.deepStrictEqual(sc.parseSudoList(LINUX_SUDO(['(ALL : ALL) NOPASSWD: ALL'])).rootCommands, ['ALL']);
  assert.deepStrictEqual(sc.parseSudoList(LINUX_SUDO(['(root) NOPASSWD: /usr/bin/tailscale'])), { nopasswd: true, rootCommands: ['/usr/bin/tailscale'], otherUsers: [] });
  assert.deepStrictEqual(sc.parseSudoList(LINUX_SUDO(['(root, backup) NOPASSWD: /bin/systemctl restart hub'])).rootCommands, ['/bin/systemctl restart hub']);
  assert.strictEqual(sc.parseSudoList(LINUX_SUDO(['(ALL : ALL) ALL'])).nopasswd, false, '(ALL) without NOPASSWD asks for a password');
  assert.strictEqual(sc.parseSudoList(LINUX_SUDO(['(ALL, !root) NOPASSWD: ALL'])).nopasswd, false, 'everyone except root');
  // tags carry on to later commands until changed; a list wrapped onto the next line belongs to the rule above
  assert.deepStrictEqual(sc.parseSudoList(LINUX_SUDO(['(root) NOPASSWD: /usr/bin/a, PASSWD: /usr/bin/b, /usr/bin/c, NOPASSWD: /usr/bin/d,', '    /usr/bin/e'])).rootCommands, ['/usr/bin/a', '/usr/bin/d', '/usr/bin/e']);
  assert.deepStrictEqual(sc.parseSudoList(LINUX_SUDO(['(root) NOPASSWD: /usr/bin/systemctl restart', '    mymaestroai-production-worker.service'])).rootCommands, ['/usr/bin/systemctl restart mymaestroai-production-worker.service']);
  assert.deepStrictEqual(sc.parseSudoList(LINUX_SUDO(['(root) SETENV: NOPASSWD: /usr/bin/x'])).rootCommands, ['/usr/bin/x']);
  // several run-as specs on separate lines
  const many = sc.parseSudoList(LINUX_SUDO(['(ALL) ALL', '(postgres) NOPASSWD: /usr/bin/psql', '(maestrotest) NOPASSWD: ALL']));
  assert.deepStrictEqual(many, { nopasswd: false, rootCommands: [], otherUsers: ['postgres', 'maestrotest'] });
  // Defaults !authenticate: no rule asks for a password, unless it says PASSWD
  assert.strictEqual(sc.parseSudoList(LINUX_SUDO(['(ALL : ALL) ALL'], 'env_reset, !authenticate')).nopasswd, true);
  assert.strictEqual(sc.parseSudoList(LINUX_SUDO(['(ALL : ALL) PASSWD: ALL'], 'env_reset, !authenticate')).nopasswd, false);
  assert.strictEqual(sc.parseSudoList(LINUX_SUDO(['(ALL : ALL) ALL'], 'env_reset, authenticate')).nopasswd, false);
  assert.deepStrictEqual(sc.parseSudoList(''), { nopasswd: false, rootCommands: [], otherUsers: [] });
});

test('parseSudoList reads run-as lists the way sudo does (cases checked against real sudo 1.9.15): the last match wins, groups and uid-0 names count, unknowns count as root', () => {
  const p = (rule, o) => sc.parseSudoList(LINUX_SUDO([rule]), o);
  assert.strictEqual(p('(!root, ALL) NOPASSWD: ALL').nopasswd, true, 'sudo lets the last entry win: root allowed');
  assert.strictEqual(p('(ALL, !root) NOPASSWD: ALL').nopasswd, false, 'root excluded last');
  assert.deepStrictEqual(p('(ALL, !root) NOPASSWD: ALL').otherUsers, ['any account but root']);
  assert.strictEqual(p('(!#0, ALL) NOPASSWD: ALL').nopasswd, true);
  const groups = new Set(['root', 'wheel', '#0']);
  assert.strictEqual(p('(%root) NOPASSWD: ALL', { rootGroups: groups }).nopasswd, true, 'a group root belongs to');
  assert.strictEqual(p('(%#0) NOPASSWD: ALL', { rootGroups: groups }).nopasswd, true);
  assert.deepStrictEqual(p('(%staff) NOPASSWD: ALL', { rootGroups: groups }), { nopasswd: false, rootCommands: [], otherUsers: ['%staff'] });
  assert.strictEqual(p('(%staff) NOPASSWD: ALL').nopasswd, true, "root's groups unknown: counts as root");
  assert.strictEqual(p('(+admins) NOPASSWD: ALL', { rootGroups: groups }).nopasswd, true, 'netgroup: counts as root');
  const uidOf = (n) => ({ toor: 0, deploy: 1001, maestrotest: 502 })[n] ?? null;
  assert.strictEqual(p('(toor) NOPASSWD: ALL', { uidOf }).nopasswd, true, 'another name for uid 0');
  assert.deepStrictEqual(p('(deploy) NOPASSWD: ALL', { uidOf }), { nopasswd: false, rootCommands: [], otherUsers: ['deploy'] });
  assert.strictEqual(p('(ghost) NOPASSWD: ALL', { uidOf }).nopasswd, true, "a name that doesn't resolve counts as root");
  assert.strictEqual(p('(!toor, deploy) NOPASSWD: ALL', { uidOf }).nopasswd, false);
  assert.deepStrictEqual(sc.parseSudoList(MAC_SUDO, { uidOf, rootGroups: groups }).otherUsers, ['maestrotest'], 'the original case still resolves to an ordinary account');
  assert.deepStrictEqual(sc.sudoRunasNames(LINUX_SUDO(['(ALL) ALL', '(!toor, deploy, %wheel, +ng, #5) NOPASSWD: ALL', '(root) NOPASSWD: /x'])), ['toor', 'deploy']);
  // round 2, each checked against real sudo 1.9.15: every uid-0 account on its own, and an entry that doesn't match decides nothing
  assert.strictEqual(p('(root, !toor) NOPASSWD: ALL', { uidOf }).nopasswd, true, 'names match by name: excluding toor leaves root');
  assert.strictEqual(p('(toor, !root) NOPASSWD: ALL', { uidOf }).nopasswd, true, 'and excluding root leaves toor, which is uid 0');
  // round 3: uid-0 accounts nobody names, and other accounts' groups
  assert.strictEqual(p('(ALL, !root) NOPASSWD: ALL', { uidOf, uidZeroNames: ['root', 'toor'] }).nopasswd, true, 'a uid-0 toor on the system is still allowed');
  assert.strictEqual(p('(ALL, !root) NOPASSWD: ALL', { uidOf, uidZeroNames: ['root'] }).nopasswd, false, 'only root is uid 0: excluded');
  assert.strictEqual(p('(ALL, !root) NOPASSWD: ALL', { uidOf }).nopasswd, true, "the system's uid-0 list unknown: assume another one");
  assert.strictEqual(p('(ALL, !#0) NOPASSWD: ALL', { uidOf }).nopasswd, false, 'excluding by uid 0 excludes them all');
  assert.strictEqual(p('(toor, %!root) NOPASSWD: ALL', { uidOf, rootGroups: groups, uidZeroNames: ['root', 'toor'] }).nopasswd, true, "toor's groups are unknown: the exclusion is ignored for it");
  assert.strictEqual(p('(ALL, !root) NOPASSWD: ALL', { uidOf, uidZeroNames: ['root'], uidZeroComplete: false }).nopasswd, true, 'directory accounts may be missing from the list: assume one more');
  const exemptOut = (rule) => LINUX_SUDO([rule], 'env_reset, exempt_group=staff');
  assert.strictEqual(sc.parseSudoList(exemptOut('(ALL : ALL) ALL'), { userGroups: new Set(['staff']) }).nopasswd, true, 'exempt_group members never type a password');
  assert.strictEqual(sc.parseSudoList(exemptOut('(ALL : ALL) PASSWD: ALL'), { userGroups: new Set(['staff']) }).nopasswd, true, 'not even for PASSWD: commands');
  assert.strictEqual(sc.parseSudoList(exemptOut('(ALL : ALL) ALL'), { userGroups: new Set(['users']) }).nopasswd, false, 'not a member');
  assert.strictEqual(sc.parseSudoList(exemptOut('(ALL : ALL) ALL')).nopasswd, true, 'membership unknown: counted');
  assert.strictEqual(p('(ALL, !ghost) NOPASSWD: ALL', { uidOf }).nopasswd, true, 'excluding an unknown name leaves root');
  assert.strictEqual(p('(ALL, !+nobody) NOPASSWD: ALL').nopasswd, true, 'an unknown exclusion never removes access');
  assert.strictEqual(p('(ALL, !%staff) NOPASSWD: ALL').nopasswd, true, "root's groups unknown: the exclusion is ignored");
  assert.strictEqual(p('(ALL, %staff) NOPASSWD: ALL', { rootGroups: groups }).nopasswd, true, 'a last entry that does not match decides nothing');
  assert.strictEqual(p('(ALL, %!staff) NOPASSWD: ALL', { rootGroups: groups }).nopasswd, true, 'sudo prints an excluded group as %!group');
  assert.strictEqual(p('(ALL, %!root) NOPASSWD: ALL', { rootGroups: groups }).nopasswd, false, "excluding root's group excludes root");
  assert.strictEqual(p('(#00) NOPASSWD: ALL').nopasswd, true);
  assert.strictEqual(p('(#1001) NOPASSWD: ALL').nopasswd, false);
  assert.strictEqual(p('(root) TIMEOUT=300 NOPASSWD: ALL').nopasswd, true, 'options come before the tags');
  assert.deepStrictEqual(p('(ALL) CWD=/tmp NOPASSWD: ALL').rootCommands, ['ALL']);
  assert.strictEqual(p('(root) TIMEOUT=300 PASSWD: ALL').nopasswd, false);
  const specific = 'env_reset, !authenticate\n\nRunas and Command-specific defaults for hub:\n    Defaults!/usr/bin/ls authenticate';
  assert.strictEqual(sc.parseSudoList(LINUX_SUDO(['(ALL : ALL) ALL'], specific)).nopasswd, true, 'a command-specific authenticate does not undo the general !authenticate');
  assert.strictEqual(sc.parseSudoList(LINUX_SUDO(['(ALL : ALL) ALL'], 'env_reset\n\nRunas and Command-specific defaults for hub:\n    Defaults>root !authenticate')).nopasswd, true, 'a specific !authenticate may cover a root rule: counted');
});

test('root-account and root-reach: no warning when sudo is passwordless only as another user; a warning naming the commands for a root rule', async () => {
  const run = (sudoText) => sc.createSecurityCheck({ ...BAD, sudoStatus: async () => sc.parseSudoList(sudoText), dockerGroup: async () => ({ inGroup: false, rootless: false }) }).check();
  const mac = await run(MAC_SUDO);
  assert.strictEqual(byId(mac, 'root-account').level, 'info', JSON.stringify(byId(mac, 'root-account')));
  assert.match(byId(mac, 'root-account').detail, /not to act as maestrotest.*not checked/);
  assert.strictEqual(byId(mac, 'root-reach'), undefined);
  const all = await run(LINUX_SUDO(['(ALL) NOPASSWD: ALL']));
  assert.strictEqual(byId(all, 'root-account').level, 'warn'); assert.match(byId(all, 'root-account').detail, /sudo needs no password/);
  assert.strictEqual(byId(all, 'root-reach').level, 'warn');
  const clean = await run(LINUX_SUDO(['(ALL : ALL) ALL']));
  assert.strictEqual(byId(clean, 'root-account').level, 'ok', 'a password for everything: no claim to check');
  const tail = await run(LINUX_SUDO(['(root) NOPASSWD: /usr/bin/tailscale']));
  assert.strictEqual(byId(tail, 'root-account').level, 'warn');
  assert.match(byId(tail, 'root-account').detail, /sudo runs \/usr\/bin\/tailscale as root without a password/);
  assert.match(byId(tail, 'root-reach').detail, /sudo runs \/usr\/bin\/tailscale as root without a password/);
});

// ── "Require two-factor sign-in for admins" off (requireAdmin2fa === false) ──
const adminsCheck = (admins, settings, exposed) => sc.createSecurityCheck({
  ...BAD, env: {}, exposed: () => exposed, hasUsers: () => true, listUsers: () => admins,
  getSetting: (k) => settings[k],
}).check();
const ADMIN_OFF = { login: 'owner@example.com', role: 'admin', totpEnabled: false };
const ADMIN_ON = { login: 'sam@example.com', role: 'admin', totpEnabled: true };

test('admin two-factor optional: an admin without it is a warning, critical when exposed; no totp item', async () => {
  const quiet = await adminsCheck([ADMIN_OFF, ADMIN_ON], { requireAdmin2fa: false }, false);
  const w = byId(quiet, 'admin-2fa-optional');
  assert.strictEqual(w.level, 'warn');
  assert.strictEqual(w.group, 'accounts');
  assert.strictEqual(w.title, 'Two-factor sign-in is optional for admins');
  assert.strictEqual(w.detail, '1 admin account(s) can sign in with a password alone.');
  assert.strictEqual(w.fix, 'Settings, Security: turn on "Require two-factor sign-in for admins".');
  assert.strictEqual(byId(quiet, 'totp'), undefined);
  const open = await adminsCheck([ADMIN_OFF], { requireAdmin2fa: false }, true);
  assert.strictEqual(byId(open, 'admin-2fa-optional').level, 'critical');
  assert.strictEqual(byId(open, 'totp'), undefined);
});

test('admin two-factor optional: every admin has it -> info, the accounts ok item stays', async () => {
  const r = await adminsCheck([ADMIN_ON], { requireAdmin2fa: false }, false);
  assert.strictEqual(byId(r, 'admin-2fa-optional').level, 'info');
  assert.strictEqual(byId(r, 'admin-2fa-optional').detail, 'Every admin still has two-factor, but any of them may remove it.');
  assert.strictEqual(byId(r, 'accounts').level, 'ok');
  assert.strictEqual(byId(r, 'totp'), undefined);
});

test('admin two-factor required (default, or anything but false): output is the old totp item', async () => {
  const base = await adminsCheck([ADMIN_OFF], {}, false);
  for (const v of [true, 'false', 0, null]) {
    const r = await adminsCheck([ADMIN_OFF], { requireAdmin2fa: v }, false);
    assert.deepStrictEqual(r.items, base.items);
  }
  assert.strictEqual(byId(base, 'totp').level, 'warn');
  assert.strictEqual(byId(base, 'totp').title, '1 admin account(s) without two-factor');
  assert.strictEqual(byId(base, 'admin-2fa-optional'), undefined);
  assert.strictEqual(byId(await adminsCheck([ADMIN_OFF], {}, true), 'totp').level, 'critical');
});
