'use strict';
// The service-mode scripts (install.sh, uninstall.sh): validation, the unit text and the refusals. Nothing here needs root or touches the system.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hashPassword } = require('../modules/remote-computers/lib/meshserver.js');

const SERVICE_DIR = path.join(__dirname, '..', 'modules', 'remote-computers', 'service');
const INSTALL = path.join(SERVICE_DIR, 'install.sh');
const UNINSTALL = path.join(SERVICE_DIR, 'uninstall.sh');
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const skipRoot = IS_ROOT ? 'needs a non-root test process' : false;

const tmpRoots = [];
test.after(() => { for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true }); });

const ADMIN_HASH = hashPassword('owner-secret-one').arg;
const AGENT_HASH = hashPassword('sam-secret-two').arg;

// A fake layout: HOME/service/{request.env,config.json}, RT/node_modules/meshcentral/{meshcentral.js,package.json}, a fake node.
function layout(overrides = {}, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mmr-service-'));
  tmpRoots.push(root);
  const home = path.join(root, 'hub');
  const sdir = path.join(home, 'service');
  const rt = path.join(root, 'runtime');
  const mc = path.join(rt, 'node_modules', 'meshcentral');
  const app = path.join(root, 'app');
  fs.mkdirSync(app);
  fs.mkdirSync(sdir, { recursive: true });
  fs.chmodSync(sdir, 0o700);
  fs.mkdirSync(mc, { recursive: true });
  if (!opts.noMeshJs) fs.writeFileSync(path.join(mc, 'meshcentral.js'), '// fake\n');
  fs.writeFileSync(path.join(mc, 'package.json'), JSON.stringify({ name: 'meshcentral', version: opts.pkgVersion || '1.3.1' }));
  const node = path.join(root, 'node');
  fs.writeFileSync(node, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(node, 0o755);
  fs.writeFileSync(path.join(sdir, 'config.json'), '{"settings":{"port":9971}}\n');
  const values = {
    MMR_VERSION: '1',
    MMR_NAME: 'mymaestro-remote',
    MMR_HUB_HOME: home,
    MMR_APP_DIR: app,
    MMR_RUNTIME_DIR: rt,
    MMR_NODE: node,
    MMR_MESH_VERSION: '1.3.1',
    MMR_CONTROL_PORT: '9971',
    MMR_AGENT_ALLOWED: '100.64.0.0/10,192.0.2.7',
    MMR_ADMIN_USER: 'owner',
    MMR_ADMIN_HASH: ADMIN_HASH,
    MMR_AGENT_USER: 'sam',
    MMR_AGENT_HASH: AGENT_HASH,
    ...overrides,
  };
  const req = path.join(sdir, 'request.env');
  const text = Object.entries(values).filter(([, v]) => v !== null).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  fs.writeFileSync(req, opts.rawRequest !== undefined ? opts.rawRequest(text) : text);
  fs.chmodSync(req, 0o600);
  return { root, home, sdir, rt, mc, node, req, values, app };
}

function run(script, args) {
  const r = spawnSync('bash', [script, ...args], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', all: `${r.stdout || ''}${r.stderr || ''}` };
}
const check = (req) => run(INSTALL, ['--check', req]);
const unitOf = (req) => run(INSTALL, ['--print-unit', req]);

function refuses(t, req, pattern) {
  const r = check(req);
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.all}`);
  assert.match(r.err, /refused/);
  if (pattern) assert.match(r.err, pattern);
  assert.equal(r.out, '');
}

test('the scripts pass bash -n and hold only ASCII', () => {
  for (const f of [INSTALL, UNINSTALL]) {
    const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/[^\x00-\x7f]/.test(fs.readFileSync(f, 'utf8')), `${f} has a non-ASCII character`);
  }
});

test('--help prints usage and exits 0 for both scripts', () => {
  assert.equal(run(INSTALL, ['--help']).code, 0);
  assert.match(run(INSTALL, ['--help']).out, /--check/);
  assert.equal(run(UNINSTALL, ['--help']).code, 0);
  assert.match(run(UNINSTALL, ['--help']).out, /--keep-data/);
});

test('a valid request: --check prints ok', { skip: skipRoot }, () => {
  const L = layout();
  const r = check(L.req);
  assert.equal(r.code, 0, r.all);
  assert.equal(r.out.trim(), 'ok');
});

test('the hash helper has the shape the script expects', () => {
  assert.match(ADMIN_HASH, /^[A-Za-z0-9+/]{171}=,[A-Za-z0-9+/]{171}=$/);
});

test('--print-unit has every hardening line once, the hub-home comment and the allow list', { skip: skipRoot }, () => {
  const L = layout({ MMR_NAME: 'mymaestro-remote-test', MMR_AGENT_ALLOWED: '100.64.0.0/10, 192.0.2.7 ,198.51.100.0/24' });
  const r = unitOf(L.req);
  assert.equal(r.code, 0, r.all);
  const lines = r.out.split('\n');
  const once = (line) => assert.equal(lines.filter((l) => l === line).length, 1, `expected exactly one "${line}"`);
  const N = 'mymaestro-remote-test';
  for (const l of [
    '# Written by My Maestro (Remote computers). Remove with uninstall.sh.',
    `# My Maestro hub home: ${L.home}`,
    `# My Maestro hub account: ${process.getuid()}:${fs.statSync(L.req).gid}`,
    `InaccessiblePaths=-${fs.realpathSync(L.app)} -${fs.realpathSync(L.home)} -/usr/local`,
    '[Unit]', '[Service]', '[Install]',
    'Description=My Maestro remote computers (MeshCentral)',
    'After=network-online.target tailscaled.service',
    'Wants=network-online.target',
    'StartLimitIntervalSec=0',
    'Type=simple', `User=${N}`, `Group=${N}`,
    `WorkingDirectory=/opt/${N}/runtime`,
    'Environment=NODE_ENV=production', `Environment=HOME=/var/lib/${N}`,
    `ExecStart=/opt/${N}/node /opt/${N}/runtime/node_modules/meshcentral/meshcentral.js --datapath /var/lib/${N}/meshcentral-data --npmpath "/opt/${N}/node /opt/${N}/no-npm.js"`,
    'Restart=always', 'RestartSec=10', 'TimeoutStopSec=20', 'UMask=0077',
    `StateDirectory=${N}`, 'StateDirectoryMode=0700',
    'TemporaryFileSystem=/:ro',
    `BindReadOnlyPaths=/usr -/lib -/lib64 -/bin -/sbin -/etc/ld.so.cache -/etc/localtime -/etc/passwd -/etc/group -/etc/nsswitch.conf -/opt/${N}`,
    'MountAPIVFS=yes',
    'NoNewPrivileges=yes', 'ProtectHome=yes', 'PrivateTmp=yes', 'PrivateDevices=yes',
    'ProtectKernelTunables=yes', 'ProtectKernelModules=yes', 'ProtectKernelLogs=yes', 'ProtectControlGroups=yes',
    'ProtectClock=yes', 'ProtectHostname=yes', 'ProtectProc=invisible', 'RestrictNamespaces=yes', 'RestrictRealtime=yes',
    'RestrictSUIDSGID=yes', 'LockPersonality=yes', 'RemoveIPC=yes', 'CapabilityBoundingSet=', 'AmbientCapabilities=',
    'SystemCallArchitectures=native', 'SystemCallFilter=@system-service', 'SystemCallFilter=~@privileged',
    'SystemCallFilter=~connect sendto sendmsg sendmmsg io_uring_setup io_uring_enter io_uring_register',
    'SystemCallErrorNumber=EPERM', 'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK',
    'IPAddressDeny=any', 'IPAddressAllow=127.0.0.1/32 ::1/128 100.64.0.0/10 192.0.2.7 198.51.100.0/24',
    'MemoryMax=2G', 'TasksMax=512', 'WantedBy=multi-user.target',
  ]) once(l);
  assert.ok(!/mymaestro-remote(?!-test)/.test(r.out.replace(/mymaestro-remote-test/g, '')), 'the default name must not leak in');
  assert.ok(!r.all.includes(ADMIN_HASH) && !r.all.includes(AGENT_HASH), 'no hash in the output');
});

test('--print-unit with the default name and the default Tailscale range', { skip: skipRoot }, () => {
  const L = layout({ MMR_AGENT_ALLOWED: '100.64.0.0/10' });
  const r = unitOf(L.req);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /^User=mymaestro-remote$/m);
  assert.match(r.out, /^IPAddressAllow=127\.0\.0\.1\/32 ::1\/128 100\.64\.0\.0\/10$/m);
});

test('full install as non-root refuses and says it must run as root', { skip: skipRoot }, () => {
  const L = layout();
  const r = run(INSTALL, [L.req]);
  assert.equal(r.code, 1);
  assert.match(r.err, /must run as root/);
  const r2 = run(INSTALL, ['--replace', L.req]);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /must run as root/);
  assert.ok(fs.existsSync(L.req), 'the request must be left alone');
});

test('uninstall.sh as non-root refuses', { skip: skipRoot }, () => {
  const r = run(UNINSTALL, []);
  assert.equal(r.code, 1);
  assert.match(r.err, /must run as root/);
  const r2 = run(UNINSTALL, ['--name', 'mymaestro-remote-test', '--keep-data']);
  assert.equal(r2.code, 1);
});

test('uninstall.sh refuses a bad name and unknown options', () => {
  const r = run(UNINSTALL, ['--name', 'sshd']);
  assert.equal(r.code, 1);
  assert.match(r.err, /name must look like/);
  assert.equal(run(UNINSTALL, ['--bogus']).code, 1);
});

test('refuses an unknown key', { skip: skipRoot }, () => {
  const L = layout({ MMR_EXTRA: 'x' });
  refuses(null, L.req, /unknown key/);
});

test('refuses a duplicate key', { skip: skipRoot }, () => {
  const L = layout({}, { rawRequest: (t) => `${t}MMR_NAME=mymaestro-remote\n` });
  refuses(null, L.req, /twice/);
});

test('refuses a missing key', { skip: skipRoot }, () => {
  const L = layout({ MMR_AGENT_HASH: null });
  refuses(null, L.req, /missing the key MMR_AGENT_HASH/);
});

test('refuses MMR_VERSION 2', { skip: skipRoot }, () => {
  refuses(null, layout({ MMR_VERSION: '2' }).req, /MMR_VERSION must be 1/);
});

test('refuses a mesh version other than 1.3.1 in the request', { skip: skipRoot }, () => {
  refuses(null, layout({ MMR_MESH_VERSION: '1.3.2' }).req, /1\.3\.1/);
});

test('refuses a runtime whose package.json is not 1.3.1', { skip: skipRoot }, () => {
  refuses(null, layout({}, { pkgVersion: '1.3.2' }).req, /not version 1\.3\.1/);
});

test('refuses a bad service name', { skip: skipRoot }, () => {
  for (const name of ['sshd', 'mymaestro-remote-', 'mymaestro-remote-UPPER', 'mymaestro-remote-abcdefghijklmnopq', 'mymaestro-remote x']) {
    refuses(null, layout({ MMR_NAME: name }).req, /MMR_NAME/);
  }
});

test('refuses a path with ..', { skip: skipRoot }, () => {
  const L = layout();
  refuses(null, layout({ MMR_RUNTIME_DIR: `${L.rt}/../runtime` }).req, /'\.' or '\.\.'/);
  refuses(null, layout({ MMR_NODE: '/tmp/../bin/sh' }).req, /'\.' or '\.\.'/);
  refuses(null, layout({ MMR_HUB_HOME: '/tmp/a b' }).req, /MMR_HUB_HOME/);
});

test('refuses a request file with mode 644', { skip: skipRoot }, () => {
  const L = layout();
  fs.chmodSync(L.req, 0o644);
  refuses(null, L.req, /mode 600/);
});

test('refuses a request file that is a symlink', { skip: skipRoot }, () => {
  const L = layout();
  const link = path.join(L.root, 'link.env');
  fs.symlinkSync(L.req, link);
  refuses(null, link, /symbolic link/);
});

test('refuses a request that is not at HOME_DIR/service/request.env', { skip: skipRoot }, () => {
  const L = layout();
  const other = path.join(L.root, 'other.env');
  fs.copyFileSync(L.req, other);
  fs.chmodSync(other, 0o600);
  refuses(null, other, /must be .*service\/request\.env/);
});

test('refuses when meshcentral.js is missing', { skip: skipRoot }, () => {
  refuses(null, layout({}, { noMeshJs: true }).req, /meshcentral\.js does not exist/);
});

test('refuses equal admin and agent users', { skip: skipRoot }, () => {
  refuses(null, layout({ MMR_AGENT_USER: 'owner' }).req, /must be different/);
});

test('refuses a bad hash', { skip: skipRoot }, () => {
  refuses(null, layout({ MMR_ADMIN_HASH: 'abc,def' }).req, /MMR_ADMIN_HASH/);
  refuses(null, layout({ MMR_AGENT_HASH: `${AGENT_HASH};id` }).req, /MMR_AGENT_HASH/);
});

test('refuses port 80 and a non-number port', { skip: skipRoot }, () => {
  refuses(null, layout({ MMR_CONTROL_PORT: '80' }).req, /MMR_CONTROL_PORT/);
  refuses(null, layout({ MMR_CONTROL_PORT: '70000' }).req, /MMR_CONTROL_PORT/);
  refuses(null, layout({ MMR_CONTROL_PORT: '99x1' }).req, /MMR_CONTROL_PORT/);
});

test('refuses bad addresses and ranges', { skip: skipRoot }, () => {
  refuses(null, layout({ MMR_AGENT_ALLOWED: '300.1.1.1' }).req, /MMR_AGENT_ALLOWED/);
  refuses(null, layout({ MMR_AGENT_ALLOWED: '10.0.0.0/33' }).req, /MMR_AGENT_ALLOWED/);
  refuses(null, layout({ MMR_AGENT_ALLOWED: '0.0.0.0/0' }).req, /MMR_AGENT_ALLOWED/);
  refuses(null, layout({ MMR_AGENT_ALLOWED: '192.0.2.1,,192.0.2.2' }).req, /MMR_AGENT_ALLOWED/);
  refuses(null, layout({ MMR_AGENT_ALLOWED: '192.0.2.1;id' }).req, /MMR_AGENT_ALLOWED/);
});

test('refuses 17 entries and accepts 16', { skip: skipRoot }, () => {
  const list = (n) => Array.from({ length: n }, (_, i) => `192.0.2.${i + 1}`).join(',');
  refuses(null, layout({ MMR_AGENT_ALLOWED: list(17) }).req, /between 1 and 16/);
  const ok = layout({ MMR_AGENT_ALLOWED: list(16) });
  assert.equal(check(ok.req).code, 0);
});

test('refuses a config.json that is too big or a symlink', { skip: skipRoot }, () => {
  const big = layout();
  fs.writeFileSync(path.join(big.sdir, 'config.json'), 'x'.repeat(65537));
  refuses(null, big.req, /larger than 65536/);
  const ok = layout();
  fs.writeFileSync(path.join(ok.sdir, 'config.json'), 'x'.repeat(65536));
  assert.equal(check(ok.req).code, 0);
  const sym = layout();
  const cfg = path.join(sym.sdir, 'config.json');
  fs.rmSync(cfg);
  fs.symlinkSync(path.join(sym.root, 'node'), cfg);
  refuses(null, sym.req, /symbolic link/);
});

test('refuses a request file that is too big', { skip: skipRoot }, () => {
  const L = layout({}, { rawRequest: (t) => `${t}# ${'x'.repeat(9000)}\n` });
  refuses(null, L.req, /larger than 8192/);
});

test('--print-unit never re-exposes the real root: no ProtectSystem (it binds / back over the empty root)', { skip: skipRoot }, () => {
  const L = layout();
  const r = unitOf(L.req);
  assert.equal(r.code, 0, r.all);
  assert.doesNotMatch(r.out, /^ProtectSystem=/m);
  assert.doesNotMatch(r.out, /^DynamicUser=/m, 'DynamicUser implies ProtectSystem=strict');
  assert.match(r.out, /^TemporaryFileSystem=\/:ro$/m);
});

test('no script handed to systemd-run uses ${...}: systemd expands those forms itself before bash sees them', () => {
  const text = fs.readFileSync(INSTALL, 'utf8');
  const scripts = [...text.matchAll(/(?:as_service|run_in_sandbox)\b[^\n]*?-c '([^']*)'/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 4, `found ${scripts.length} sandboxed scripts`);
  for (const s of scripts) {
    assert.ok(!s.includes('${'), `a sandboxed script uses \${...}: ${s.slice(0, 80)}`);
    assert.ok(!s.includes('$$'), `a sandboxed script uses $$: ${s.slice(0, 80)}`);
    assert.ok(!s.includes('%'), `a sandboxed script uses a % specifier: ${s.slice(0, 80)}`);
    assert.ok(!/^\s*\$[A-Za-z_]\w*\s*$/.test(s), `a sandboxed script is one whole-word $NAME, which systemd would replace: ${s}`);
  }
  // The other words given to systemd-run inside the sandbox helpers (the Node probe) hold no $ or % at all.
  const nodeProbe = /"\$NEW_DIR\/node" -e \\\n\s*"([^"]*)"/.exec(text);
  assert.ok(nodeProbe, 'the Node datagram probe was found');
  assert.ok(!/[$%]/.test(nodeProbe[1]), 'the Node probe holds no $ or %');
});
