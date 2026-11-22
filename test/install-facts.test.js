'use strict';
// lib/install-facts: read-only facts about the computer the hub runs on. Every command and file read is injected; nothing real is run.
const test = require('node:test');
const assert = require('node:assert');
const { createInstallFacts, suggestFor, isTailnetIp, CLI_CANDIDATES } = require('../lib/install-facts');

const STATUS = (over = {}) => JSON.stringify({
  BackendState: 'Running', TUN: true,
  Self: { DNSName: 'hub.example.ts.net.', HostName: 'hub', TailscaleIPs: ['100.101.102.103', '2001:db8::1'] },
  Peer: { nodekey1: { DNSName: 'sam-laptop.example.ts.net.', TailscaleIPs: ['100.64.0.9'], HostName: 'sam-laptop' } },
  ...over,
});
const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
const missing = () => { const e = new Error('spawn ENOENT'); e.code = 'ENOENT'; throw e; };
const fsOk = { existsSync: (p) => p === '/run/systemd/system', statfs: (p, cb) => cb(null, { bavail: 1000, bsize: 1048576 }) };
function make(runImpl, extra = {}) {
  const calls = [];
  const run = async (file, args, opts) => { calls.push({ file, args, opts }); return runImpl(file, args, opts); };
  return { calls, facts: createInstallFacts({ platform: 'linux', run, fsx: fsOk, env: { PORT: '9970' }, hostname: () => 'box', dataDir: '/nonexistent/data', ...extra }) };
}

test('running: the host loses its trailing dot, only IPv4 tailnet addresses are kept, no peer is returned', async () => {
  const { facts } = make(() => ok(STATUS()));
  const f = await facts.get();
  assert.strictEqual(f.tailscale.state, 'running');
  assert.strictEqual(f.tailscale.host, 'hub.example.ts.net');
  assert.deepStrictEqual(f.tailscale.ips, ['100.101.102.103']);
  assert.strictEqual(f.tailscale.userspace, false);
  assert.strictEqual(f.tailscale.cli, 'tailscale');
  const text = JSON.stringify(f);
  assert.ok(!text.includes('sam-laptop') && !text.includes('100.64.0.9'), 'nothing from the peer list leaves it');
  assert.deepStrictEqual(Object.keys(f).sort(), ['free_disk_mb', 'has_systemd', 'hostname', 'hub_port', 'os', 'supported', 'tailscale']);
});

test('only addresses inside 100.64.0.0/10 that Self reports are ever offered', async () => {
  const self = { DNSName: 'h.example.ts.net.', TailscaleIPs: ['192.0.2.5', '100.63.255.255', '100.128.0.1', '10.0.0.1', '100.064.1.1', '100.127.255.254', '100.64.0.0', '198.51.100.7'] };
  const { facts } = make(() => ok(STATUS({ Self: self })));
  assert.deepStrictEqual((await facts.get()).tailscale.ips, ['100.127.255.254', '100.64.0.0']);
  for (const bad of ['192.0.2.1', '100.63.0.1', '100.128.0.0', '203.0.113.9', '::1', '', null, '100.64.0', '100.64.0.256']) assert.strictEqual(isTailnetIp(bad), false, String(bad));
  assert.strictEqual(isTailnetIp('100.101.102.103'), true);
});

test('NeedsLogin, NoState and Stopped are logged-out and offer no address; other backend states are unknown', async () => {
  for (const bs of ['NeedsLogin', 'NoState', 'Stopped']) {
    const { facts } = make(() => ok(STATUS({ BackendState: bs })));
    const f = (await facts.get()).tailscale;
    assert.strictEqual(f.state, 'logged-out', bs);
    assert.deepStrictEqual(f.ips, []);
    assert.strictEqual(f.host, '');
  }
  const { facts } = make(() => ok(STATUS({ BackendState: 'Starting' })));
  assert.strictEqual((await facts.get()).tailscale.state, 'unknown');
});

test('TUN false means userspace networking', async () => {
  const { facts } = make(() => ok(STATUS({ TUN: false })));
  const f = (await facts.get()).tailscale;
  assert.strictEqual(f.userspace, true);
  assert.strictEqual(f.state, 'running');
});

test('the CLI candidates are tried in order; one that is missing or times out is skipped; only status --json is run', async () => {
  assert.deepStrictEqual(CLI_CANDIDATES, ['tailscale', '/usr/bin/tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']);
  const { facts, calls } = make((file) => {
    if (file === 'tailscale') return missing();
    if (file === '/usr/bin/tailscale') return { code: null, stdout: '', stderr: '', timedOut: true };
    return ok(STATUS());
  }, { timeoutMs: 1234 });
  const f = (await facts.get()).tailscale;
  assert.strictEqual(f.cli, '/usr/local/bin/tailscale');
  assert.deepStrictEqual(calls.map(c => c.file), ['tailscale', '/usr/bin/tailscale', '/usr/local/bin/tailscale']);
  for (const c of calls) { assert.deepStrictEqual(c.args, ['status', '--json']); assert.strictEqual(c.opts.timeout, 1234); }
});

test('no CLI anywhere is not-installed; a CLI whose daemon does not answer is not-running; garbled JSON is unknown with a reason', async () => {
  const a = make(() => missing());
  assert.strictEqual((await a.facts.get()).tailscale.state, 'not-installed');
  assert.strictEqual(a.calls.length, CLI_CANDIDATES.length);
  const b = make((file) => (file === '/usr/bin/tailscale' ? { code: 1, stdout: '', stderr: 'failed to connect to local tailscaled' } : missing()));
  const bs = (await b.facts.get()).tailscale;
  assert.strictEqual(bs.state, 'not-running');
  assert.ok(bs.detail && bs.detail.length > 5);
  const c = make(() => ok('{not json'));
  const cs = (await c.facts.get()).tailscale;
  assert.strictEqual(cs.state, 'unknown');
  assert.match(cs.detail, /could not be read/);
  assert.deepStrictEqual(cs.ips, []);
  const d = make(() => { throw new Error('boom'); });   // an odd failure counts as a timeout, never a crash
  assert.strictEqual((await d.facts.get()).tailscale.state, 'not-running');
});

test('os, systemd, hostname, port and free disk', async () => {
  const { facts } = make(() => ok(STATUS()));
  const f = await facts.get();
  assert.strictEqual(f.os, 'linux'); assert.strictEqual(f.supported, true); assert.strictEqual(f.has_systemd, true);
  assert.strictEqual(f.hostname, 'box'); assert.strictEqual(f.hub_port, 9970); assert.strictEqual(f.free_disk_mb, 1000);
  const noPort = createInstallFacts({ platform: 'linux', run: async () => missing(), fsx: { existsSync: () => false }, env: {}, hostname: () => 'h' });
  const g = await noPort.get();
  assert.strictEqual(g.hub_port, null); assert.strictEqual(g.free_disk_mb, null); assert.strictEqual(g.has_systemd, false);
  const mac = createInstallFacts({ platform: 'darwin', run: async () => ok(STATUS()), fsx: { existsSync: () => true }, env: { PORT: 'abc' }, hostname: () => 'm' });
  const m = await mac.get();
  assert.strictEqual(m.os, 'darwin'); assert.strictEqual(m.supported, true); assert.strictEqual(m.has_systemd, false, 'systemd is a Linux fact'); assert.strictEqual(m.hub_port, null);
});

test('Windows and other systems: supported false, and nothing is run', async () => {
  for (const platform of ['win32', 'freebsd']) {
    let ran = 0;
    const x = createInstallFacts({ platform, run: async () => { ran++; return ok(STATUS()); }, fsx: {}, env: {}, hostname: () => 'w' });
    const f = await x.get();
    assert.strictEqual(f.os, platform); assert.strictEqual(f.supported, false); assert.strictEqual(ran, 0);
    assert.deepStrictEqual(f.tailscale.ips, []);
  }
});

test('the answer is cached for 30 seconds, then asked again', async () => {
  let t = 1000;
  const { facts, calls } = make(() => ok(STATUS()), { now: () => t });
  await facts.get(); await facts.get();
  assert.strictEqual(calls.length, 1);
  t += 29000; await facts.get();
  assert.strictEqual(calls.length, 1);
  t += 2000; await facts.get();
  assert.strictEqual(calls.length, 2);
  const [p, q] = await Promise.all([make(() => ok(STATUS())).facts.get(), make(() => ok(STATUS())).facts.get()]);
  assert.deepStrictEqual(p, q);
});

test('a caller changing the returned facts cannot change the cached ones', async () => {
  const { facts } = make(() => ok(STATUS()));
  const a = await facts.get(); a.tailscale.ips.push('203.0.113.9');
  assert.deepStrictEqual((await facts.get()).tailscale.ips, ['100.101.102.103']);
});

test('suggestFor: each kind, null when there is nothing, and never a non-tailnet address', () => {
  const facts = { os: 'linux', has_systemd: true, hostname: 'box', hub_port: 9970, tailscale: { host: 'hub.example.ts.net', ips: ['100.101.102.103', '100.101.102.104'] } };
  assert.deepStrictEqual(suggestFor('tailnet_host', facts), { value: 'hub.example.ts.net', candidates: ['hub.example.ts.net'] });
  assert.deepStrictEqual(suggestFor('tailnet_ip', facts), { value: '100.101.102.103', candidates: ['100.101.102.103', '100.101.102.104'] });
  assert.deepStrictEqual(suggestFor('hostname', facts), { value: 'box', candidates: ['box'] });
  assert.deepStrictEqual(suggestFor('hub_port', facts), { value: 9970, candidates: [9970] });
  assert.deepStrictEqual(suggestFor('os', facts), { value: 'linux', candidates: ['linux'] });
  assert.deepStrictEqual(suggestFor('has_systemd', facts), { value: true, candidates: [true] });
  assert.deepStrictEqual(suggestFor('has_systemd', { ...facts, has_systemd: false }), { value: false, candidates: [false] });
  assert.strictEqual(suggestFor('tailnet_ip', { tailscale: { ips: [] } }), null);
  assert.strictEqual(suggestFor('tailnet_host', { tailscale: { host: '' } }), null);
  assert.strictEqual(suggestFor('nope', facts), null);
  assert.strictEqual(suggestFor('tailnet_ip', null), null);
  assert.deepStrictEqual(suggestFor('tailnet_ip', { tailscale: { ips: ['192.0.2.5', '203.0.113.1', '100.101.102.103'] } }).candidates, ['100.101.102.103']);
  assert.strictEqual(suggestFor('tailnet_ip', { tailscale: { ips: ['192.0.2.5'] } }), null);
});
