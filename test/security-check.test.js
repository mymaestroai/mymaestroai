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
const sc = require('../lib/security-check');

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
    nodeVersion: 'v22.23.2', publicAddress: () => null, pushEndpoints: () => ['fcm.googleapis.com'], lockfilePresent: () => true,
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
  try { stdout = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'security-check.js'), '--json'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 80000 }); }
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
  for (const s of ['id="st-sec-section"', 'async function loadSecurityCheck(runNow = false)', "fetch(runNow ? '/api/security-check/run' : '/api/security-check', init)", 'async function paintSecurityBanner()',
    "paintSecurityBanner().catch(() => {});", "id = 'hub-security-notice'", "onclick=\"loadSecurityCheck(true)\">Run now</button>", 'node scripts/security-check.js']) assert.ok(app.includes(s), s);
  assert.ok(read('README.md').includes('## Security Check'));
  assert.ok(read('docs/HUB-MAP.md').includes('security-check.js'));
  assert.ok(JSON.parse(read('package.json')).scripts['security-check'] === 'node scripts/security-check.js');
});
