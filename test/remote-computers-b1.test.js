'use strict';
// Remote computers, one-button setup: the prerequisites check, the settings preparation, the plain-language checks, the installer-link
// record and the new manifest/setup. The facts are stand-ins; nothing here runs Tailscale or MeshCentral.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadModule, coerceSettings, safeSettings } = require('../lib/modules/manifest');
const mod = require('../modules/remote-computers/index');
const { createInstaller, LINK_FILE } = require('../modules/remote-computers/lib/installer');
const { createRemote } = require('../modules/remote-computers/server');

const DIR = path.join(__dirname, '..', 'modules', 'remote-computers');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rc-b1-'));
const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };

const facts = (over = {}) => ({
  os: 'linux', supported: true, has_systemd: true, hostname: 'owner-box', hub_port: 9000, free_disk_mb: 5000,
  ...over,
  tailscale: { state: 'running', userspace: false, cli: '/usr/bin/tailscale', host: 'hub.example.ts.net', ips: ['100.101.102.103'], detail: '', ...(over.tailscale || {}) },
});

// ── prechecks.prereqs ────────────────────────────────────────────────────────────────────────────
test('prereqs: a normal Linux computer passes and shows what was found', () => {
  const r = mod.prechecks.prereqs({ facts: facts(), settings: {}, platform: 'linux' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.blocker, null);
  assert.ok(r.lines.includes('Found this computer on your private network: hub.example.ts.net (100.101.102.103).'));
  assert.ok(!r.lines.some((l) => /not yet proven on a real Mac/.test(l)));
});

test('prereqs: a Mac passes with the "not yet proven" line', () => {
  const r = mod.prechecks.prereqs({ facts: facts({ os: 'darwin', has_systemd: false }), settings: {}, platform: 'darwin' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.lines.includes('New: Remote computers on a Mac is not yet proven on a real Mac.'));
});

test('prereqs: Windows and other systems are named and blocked as unsupported', () => {
  const w = mod.prechecks.prereqs({ facts: facts({ os: 'win32' }), settings: {}, platform: 'win32' });
  assert.deepStrictEqual([w.ok, w.blocker, w.summary], [false, 'unsupported', 'Remote computers can\'t run on Windows yet. It runs on Linux and Mac.']);
  const f = mod.prechecks.prereqs({ facts: facts({ os: 'freebsd' }), settings: {}, platform: 'freebsd' });
  assert.deepStrictEqual([f.ok, f.blocker, f.summary], [false, 'unsupported', 'Remote computers can\'t run on FreeBSD yet. It runs on Linux and Mac.']);
  const x = mod.prechecks.prereqs({ facts: facts({ os: 'plan9' }), settings: {}, platform: 'plan9' });
  assert.match(x.summary, /^Remote computers can't run on plan9 yet\. It runs on Linux and Mac\.$/);
});

test('prereqs: Tailscale missing says how to get it and to come back', () => {
  const r = mod.prechecks.prereqs({ facts: facts({ tailscale: { state: 'not-installed', ips: [], host: '', cli: '' } }), settings: {}, platform: 'linux' });
  assert.deepStrictEqual([r.ok, r.blocker], [false, 'tailscale-missing']);
  assert.strictEqual(r.summary, 'Tailscale isn\'t installed on the computer your Maestro runs on.');
  assert.ok(r.lines.some((l) => l.includes('https://tailscale.com/download')));
  assert.ok(r.lines.some((l) => /come back to this page/.test(l)));
});

test('prereqs: Tailscale signed out, not running, unknown or without an address is "not signed in"', () => {
  for (const tailscale of [{ state: 'logged-out', ips: [] }, { state: 'not-running', ips: [] }, { state: 'unknown', ips: [] }, { state: 'running', ips: [] }]) {
    const r = mod.prechecks.prereqs({ facts: facts({ tailscale }), settings: {}, platform: 'linux' });
    assert.deepStrictEqual([r.ok, r.blocker], [false, 'tailscale-off'], JSON.stringify(tailscale));
    assert.strictEqual(r.summary, 'Tailscale is installed but not signed in on the computer your Maestro runs on.');
    assert.ok(r.lines.some((l) => /Open Tailscale on it and sign in/.test(l)));
    assert.ok(r.lines.some((l) => /come back/.test(l)));
  }
});

test('prereqs: userspace networking is refused with the advice to install the app', () => {
  const r = mod.prechecks.prereqs({ facts: facts({ tailscale: { userspace: true } }), settings: {}, platform: 'linux' });
  assert.deepStrictEqual([r.ok, r.blocker], [false, 'tailscale-userspace']);
  assert.match(r.summary, /runs in a mode other programs can't listen on \(userspace networking\)/);
  assert.ok(r.lines.some((l) => /Install the Tailscale app instead of the command-line-only version/.test(l)));
});

test('prereqs: under 300 MB free is a disk blocker with the number; 300 and unknown pass', () => {
  const low = mod.prechecks.prereqs({ facts: facts({ free_disk_mb: 120 }), settings: {}, platform: 'linux' });
  assert.deepStrictEqual([low.ok, low.blocker], [false, 'disk']);
  assert.match(low.summary, /120 MB free/);
  assert.strictEqual(mod.prechecks.prereqs({ facts: facts({ free_disk_mb: 300 }), settings: {}, platform: 'linux' }).ok, true);
  assert.strictEqual(mod.prechecks.prereqs({ facts: facts({ free_disk_mb: null }), settings: {}, platform: 'linux' }).ok, true);
});

test('prereqs: the blockers come first-found in order: system, Tailscale, disk', () => {
  const r = mod.prechecks.prereqs({ facts: facts({ free_disk_mb: 1, tailscale: { state: 'not-installed', ips: [] } }), settings: {}, platform: 'linux' });
  assert.strictEqual(r.blocker, 'tailscale-missing');
});

// ── setup.prepare ────────────────────────────────────────────────────────────────────────────────
const free = async () => true;
const ctxFor = (over = {}) => ({ facts: facts(), settings: {}, platform: 'linux', choices: {}, portFree: free, ...over });

test('prepare: saved ports equal to the defaults stay, even while they are busy (its own running server holds them)', async () => {
  const saved = { address_name: 'hub.example.ts.net', listen_ip: '100.101.102.103', control_port: 9971, agent_port: 9972, run_as: 'service' };
  const r = await mod.setup.prepare(ctxFor({ settings: saved, saved, portFree: async () => false }));
  assert.strictEqual(r.stop, null);
  assert.deepStrictEqual(r.settings, {}, 'nothing saved is returned, so nothing changes');
  assert.ok(r.lines.some((l) => /Using the saved ports 9971 and 9972/.test(l)), r.lines.join(' | '));
});

test('prepare: empty settings are filled from the facts: name, address, ports 9971/9972, run_as auto', async () => {
  const r = await mod.setup.prepare(ctxFor({ saved: {} }));
  assert.strictEqual(r.stop, null);
  assert.strictEqual(r.choose, null);
  assert.deepStrictEqual(r.settings, { listen_ip: '100.101.102.103', address_name: 'hub.example.ts.net', control_port: 9971, agent_port: 9972, run_as: 'auto' });
  assert.ok(r.lines.includes('It will run as its own locked-down service.'));
  assert.ok(r.lines.includes('Found this computer on your private network: hub.example.ts.net (100.101.102.103).'));
});

test('prepare: the address is only ever one of this computer\'s own Tailscale addresses', async () => {
  const seen = [];
  const r = await mod.setup.prepare(ctxFor({ saved: {}, portFree: async (p, h) => { seen.push([p, h]); return true; } }));
  assert.strictEqual(r.settings.listen_ip, '100.101.102.103');
  assert.deepStrictEqual(seen, [[9971, '127.0.0.1'], [9972, '100.101.102.103']], 'the control port on loopback, the computer port on the tailnet address');
  // an address named in the choices that Tailscale did not report is not taken
  const bad = await mod.setup.prepare(ctxFor({ saved: {}, choices: { listen_ip: '203.0.113.9' } }));
  assert.ok(bad.choose && bad.choose.key === 'listen_ip');
  assert.deepStrictEqual(bad.choose.options.map((o) => o.value), ['100.101.102.103']);
  assert.strictEqual(bad.settings.listen_ip, undefined);
});

test('prepare: no Tailscale address stops, with nothing proposed', async () => {
  const r = await mod.setup.prepare(ctxFor({ saved: {}, facts: facts({ tailscale: { state: 'logged-out', ips: [] } }) }));
  assert.match(r.stop, /^Tailscale is not signed in on the computer your Maestro runs on/);
  assert.deepStrictEqual(r.settings, {});
});

test('prepare: several addresses ask which one, first listed; the answer is kept; a saved address is never asked about', async () => {
  const two = facts({ tailscale: { ips: ['100.101.102.103', '100.101.102.104'] } });
  const ask = await mod.setup.prepare(ctxFor({ saved: {}, facts: two }));
  assert.deepStrictEqual(ask.choose.options.map((o) => o.value), ['100.101.102.103', '100.101.102.104']);
  assert.strictEqual(ask.choose.key, 'listen_ip');
  assert.ok(ask.choose.label.length > 10);
  const done = await mod.setup.prepare(ctxFor({ saved: {}, facts: two, choices: { listen_ip: '100.101.102.104' } }));
  assert.strictEqual(done.choose, null);
  assert.strictEqual(done.settings.listen_ip, '100.101.102.104');
  const kept = await mod.setup.prepare(ctxFor({ saved: { listen_ip: '100.101.102.104' }, settings: { listen_ip: '100.101.102.104' }, facts: two }));
  assert.strictEqual(kept.choose, null);
  assert.strictEqual(kept.settings.listen_ip, undefined, 'a saved value is not returned');
});

test('prepare: a saved address that is not this computer\'s Tailscale address stops and is never replaced', async () => {
  const r = await mod.setup.prepare(ctxFor({ saved: { listen_ip: '100.64.0.77' }, settings: { listen_ip: '100.64.0.77' } }));
  assert.strictEqual(r.stop, 'The saved address 100.64.0.77 is not this computer\'s Tailscale address now (100.101.102.103). Change it under Advanced.');
  assert.deepStrictEqual(r.settings, {});
});

test('prepare: saved name, ports and run_as are never overwritten', async () => {
  const saved = { address_name: 'mine.example.ts.net', listen_ip: '100.101.102.103', control_port: 9100, agent_port: 9200, run_as: 'hub' };
  const r = await mod.setup.prepare(ctxFor({ saved, settings: { ...saved }, portFree: async () => { throw new Error('saved ports are not probed'); } }));
  assert.deepStrictEqual(r.settings, {});
  assert.strictEqual(r.stop, null);
  assert.ok(r.lines.includes('It will run under your Maestro\'s own account. The server then has the same access to files as your Maestro.'));
});

test('prepare: ports in use move to the next free pair; no free pair within 50 stops', async () => {
  const busy = new Set([9971, 9972, 9973, 9975]);
  const r = await mod.setup.prepare(ctxFor({ saved: {}, portFree: async (p) => !busy.has(p) }));
  // pair 0: 9971/9972 busy; pair 1: 9972 busy; pair 2: 9973 busy; pair 3: 9974 free but 9975 busy; pair 4: 9975 busy; pair 5: 9976/9977 free
  assert.deepStrictEqual([r.settings.control_port, r.settings.agent_port], [9976, 9977]);
  assert.ok(r.lines.some((l) => /9971 and 9972 are in use, so it will use 9976 and 9977/.test(l)));
  const none = await mod.setup.prepare(ctxFor({ saved: {}, portFree: async () => false }));
  assert.ok(none.stop && /No free ports/.test(none.stop));
  assert.deepStrictEqual(none.settings, {});
});

test('prepare: without the raw saved settings, a value equal to the default counts as not saved, another value as saved', async () => {
  const a = await mod.setup.prepare(ctxFor({ settings: { control_port: 9971, agent_port: 9972, run_as: 'auto', address_name: '', listen_ip: '' } }));
  assert.strictEqual(a.settings.control_port, 9971);
  const b = await mod.setup.prepare(ctxFor({ settings: { control_port: 9100, agent_port: 9200, run_as: 'auto', address_name: '', listen_ip: '' }, portFree: async () => { throw new Error('not probed'); } }));
  assert.strictEqual(b.settings.control_port, undefined);
  assert.strictEqual(b.settings.listen_ip, '100.101.102.103');
});

test('prepare: run_as lines: service on Linux with systemd; the Mac, no systemd and hub run under the Maestro account', async () => {
  const svc = await mod.setup.prepare(ctxFor({ saved: {} }));
  assert.ok(svc.lines.includes('It will run as its own locked-down service.'));
  const mac = await mod.setup.prepare(ctxFor({ saved: {}, platform: 'darwin', facts: facts({ os: 'darwin', has_systemd: false }) }));
  assert.ok(mac.lines.includes('It will run under your Maestro\'s own account. The server then has the same access to files as your Maestro.'));
  const noSd = await mod.setup.prepare(ctxFor({ saved: {}, facts: facts({ has_systemd: false }) }));
  assert.ok(noSd.lines.some((l) => /^It will run under your Maestro's own account\./.test(l)));
  const hub = await mod.setup.prepare(ctxFor({ saved: {}, choices: { run_as: 'hub' } }));
  assert.strictEqual(hub.settings.run_as, 'hub');
  assert.ok(hub.lines.some((l) => /^It will run under your Maestro's own account\./.test(l)));
  const macSvc = await mod.setup.prepare(ctxFor({ saved: { run_as: 'service' }, settings: { run_as: 'service' }, platform: 'darwin', facts: facts({ os: 'darwin', has_systemd: false }) }));
  assert.ok(macSvc.stop && /not available/.test(macSvc.stop));
});

test('prepare: a missing Tailscale name stops with a plain way out', async () => {
  const r = await mod.setup.prepare(ctxFor({ saved: {}, facts: facts({ tailscale: { host: '' } }) }));
  assert.ok(r.stop && /MagicDNS/.test(r.stop));
  assert.deepStrictEqual(r.settings, {});
});

// ── checks.server, checks.computer ───────────────────────────────────────────────────────────────
const ctxOf = (tools) => ({
  settings: {}, parse,
  callTool: async (name) => { const v = tools[name]; if (typeof v === 'function') return v(); if (v === undefined) throw new Error(`no stub for ${name}`); return v; },
});
const okHealth = (over = {}) => JSON.stringify({ ok: true, running: true, group: 'mesh//g1', computers: 1, online: 1, warnings: [], ...over });

test('check server: says how the server runs and returns the mode', async () => {
  const svc = await mod.checks.server(ctxOf({ health: okHealth({ mode: 'service' }) }));
  assert.deepStrictEqual([svc.ok, svc.mode, svc.summary], [true, 'service', 'The server is running as its own locked-down service. 1 computer registered, 1 online.']);
  const hub = await mod.checks.server(ctxOf({ health: okHealth({ mode: 'hub', computers: 0, online: 0 }) }));
  assert.deepStrictEqual([hub.ok, hub.mode, hub.summary], [true, 'hub', 'The server is running under your Maestro\'s own account. No computer has been added yet.']);
  const old = await mod.checks.server(ctxOf({ health: okHealth() }));
  assert.strictEqual(old.mode, undefined);
  const down = await mod.checks.server(ctxOf({ health: JSON.stringify({ ok: false, running: false, mode: 'hub', warnings: [] }) }));
  assert.deepStrictEqual([down.ok, down.mode], [false, 'hub']);
});

test('check server: a service that needs its command keeps the reason and command', async () => {
  const r = await mod.checks.server(ctxOf({ health: JSON.stringify({ mode: 'service', reason: 'not-installed', message: 'Press Ask Maestro.', command: 'sudo bash /x/install.sh', warnings: [] }) }));
  assert.deepStrictEqual([r.ok, r.reason, r.command, r.mode], [false, 'not-installed', 'sudo bash /x/install.sh', 'service']);
});

test('check server: a Mac is allowed; other systems are not', async () => {
  let called = 0;
  const base = ctxOf({ health: () => { called++; return okHealth({ mode: 'hub' }); } });
  assert.strictEqual((await mod.checks.server({ ...base, platform: 'darwin' })).ok, true);
  assert.strictEqual((await mod.checks.server({ ...base, platform: 'linux' })).ok, true);
  assert.strictEqual(called, 2);
  assert.strictEqual((await mod.checks.server({ ...base, platform: 'win32' })).ok, false);
  assert.strictEqual(called, 2);
});

test('check computer: no link made yet, a link not opened, helper downloaded but nothing registered, registered but offline', async () => {
  const none = (helper) => ctxOf({ computers_status: '[]', health: okHealth({ helper }) });
  const a = await mod.checks.computer(none({ made: false, used: false }));
  assert.match(a.summary, /^No installer link has been made yet\./);
  const b = await mod.checks.computer(none({ made: true, used: false }));
  assert.match(b.summary, /^The last installer link has not been opened yet\./);
  assert.match(b.summary, /within 15 minutes/);
  const c = await mod.checks.computer(none({ made: true, used: true }));
  assert.match(c.summary, /^The helper was downloaded, but no computer has connected yet\./);
  assert.match(c.summary, /choose Install/);
  const d = await mod.checks.computer(ctxOf({ computers_status: JSON.stringify([{ name: 'demo-pc', online: false }]), health: okHealth({ helper: { made: true, used: true } }) }));
  assert.match(d.summary, /^demo-pc registered, but it is offline\. Check that the computer is on and signed in to Tailscale with the same account/);
  for (const r of [a, b, c, d]) assert.strictEqual(r.ok, false);
});

test('check computer: with no record from the server it falls back to the one general sentence', async () => {
  const r = await mod.checks.computer(ctxOf({ computers_status: '[]' }));
  assert.strictEqual(r.summary, 'No computer has connected yet. Run the installer on the computer you want to control, then check again.');
});

// ── the link-used record ─────────────────────────────────────────────────────────────────────────
function makeInstaller(home, t) {
  const exe = Buffer.concat([Buffer.from('MZ'), Buffer.from('program')]);
  return createInstaller({ home, now: () => t.v, fetchInstaller: async () => exe, address: () => 'hub.example.ts.net' });
}

test('installer record: made, then opened, and a new link not yet opened', async () => {
  const home = tmp(), t = { v: 1783000000000 };
  const inst = makeInstaller(home, t);
  assert.deepStrictEqual(inst.stats(), { made: false, used: false });
  await inst.prepare();
  const url = inst.link().url;
  assert.deepStrictEqual(inst.stats(), { made: true, used: false });
  t.v += 5000;
  const r = await inst.receive({ method: 'GET', path: 'installer', query: { t: url.split('?t=').pop() } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(inst.stats(), { made: true, used: true });
  t.v += 5000;
  inst.link();
  assert.deepStrictEqual(inst.stats(), { made: true, used: false }, 'the last link has not been opened');
});

test('installer record: a bad or expired token does not count; a failed download does not count', async () => {
  const home = tmp(), t = { v: 1783000000000 };
  const inst = makeInstaller(home, t);
  await inst.prepare();
  inst.link();
  await inst.receive({ method: 'GET', path: 'installer', query: { t: 'abcd2345' } });
  assert.strictEqual(inst.stats().used, false);
  const fail = createInstaller({ home: tmp(), now: () => t.v, fetchInstaller: async () => { throw new Error('boom'); }, address: () => 'hub.example.ts.net' });
  const u = fail.link().url;
  assert.strictEqual((await fail.receive({ method: 'GET', path: 'installer', query: { t: u.split('?t=').pop() } })).status, 502);
  assert.strictEqual(fail.stats().used, false);
});

test('installer record: kept in the connector\'s own folder, with times only and no token, and read again after a restart', async () => {
  const home = tmp(), t = { v: 1783000000000 };
  const inst = makeInstaller(home, t);
  await inst.prepare();
  const url = inst.link().url;
  await inst.receive({ method: 'GET', path: 'installer', query: { t: url.split('?t=').pop() } });
  const file = path.join(home, LINK_FILE);
  const text = fs.readFileSync(file, 'utf8');
  assert.deepStrictEqual(Object.keys(JSON.parse(text)).sort(), ['madeAt', 'usedAt']);
  assert.ok(!text.includes(url.split('?t=').pop()));
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepStrictEqual(makeInstaller(home, t).stats(), { made: true, used: true });
  fs.writeFileSync(file, 'not json');
  assert.deepStrictEqual(makeInstaller(home, t).stats(), { made: false, used: false });
});

test('server: the health tool carries the link record as "helper" when the installer has one', async () => {
  const stats = { made: true, used: false };
  const r = createRemote({
    env: { MODULE_SETTINGS: JSON.stringify({}), CONNECTOR_DATA_HOME: tmp(), MODULE_RUNTIME_DIR: '' },
    write: () => {}, log: () => {}, deps: { platform: 'linux', installer: { stats: () => stats, link: () => ({}), receive: async () => ({}) } },
  });
  const h = await r.callTool('health');
  assert.deepStrictEqual(h.helper, { made: true, used: false });
  const none = createRemote({ env: { MODULE_SETTINGS: '{}', CONNECTOR_DATA_HOME: tmp(), MODULE_RUNTIME_DIR: '' }, write: () => {}, log: () => {}, deps: { platform: 'linux', installer: { link: () => ({}), receive: async () => ({}) } } });
  assert.strictEqual((await none.callTool('health')).helper, undefined);
});

// ── the manifest and the setup ───────────────────────────────────────────────────────────────────
test('manifest: it loads with the framework\'s validator, with the connector hooks it names', () => {
  const m = loadModule(DIR);
  assert.deepStrictEqual(m.problems, []);
  assert.strictEqual(typeof m.code.prechecks.prereqs, 'function');
  assert.strictEqual(typeof m.code.setup.prepare, 'function');
  for (const st of m.setup.steps) if (st.type === 'auto') {
    assert.strictEqual(st.precheck, 'prereqs');
    assert.strictEqual(st.prepare, true);
    assert.strictEqual(st.install, true);
    assert.strictEqual(st.check, 'server');
    assert.deepStrictEqual(st.adminChoice, { setting: 'run_as', value: 'hub', label: 'Run it without an administrator', warning: 'The server then has the same access to files as your Maestro.' });
  }
});

test('manifest: suggest and advanced keys are where the spec puts them', () => {
  const { manifest } = loadModule(DIR);
  const by = Object.fromEntries(manifest.settings.map((s) => [s.key, s]));
  assert.strictEqual(by.address_name.suggest, 'tailnet_host');
  assert.strictEqual(by.listen_ip.suggest, 'tailnet_ip');
  for (const k of ['control_port', 'agent_port', 'run_as', 'service_name', 'agent_allowed', 'session_minutes', 'approval_policy', 'desktop_who', 'desktop_minutes', 'desktop_address']) assert.strictEqual(by[k].advanced, true, k);
  for (const k of ['levels', 'no_ask_agents']) assert.ok(!by[k].advanced, k);
  assert.deepStrictEqual([by.run_as.type, by.run_as.options], ['choice', ['auto', 'service', 'hub']]);
});

test('manifest: no step of its own for the session length, and the five steps carry the planned words', () => {
  const { setup } = loadModule(DIR);
  assert.ok(!setup.steps.some((s) => s.type === 'settings'));
  const by = Object.fromEntries(setup.steps.map((s) => [s.id, s]));
  assert.match(by.add.body, /^Windows computers for now\./);
  assert.match(by.add.body, /Sign in to Tailscale on it with the same account/);
  assert.match(by.add.body, /within 15 minutes/);
  assert.match(by.add.body, /choose \*\*Install\*\*/);
  assert.match(by.add.body, /For agents to see the screen:/);
  assert.ok(!/confirm/.test(JSON.stringify(by.add)), 'the PC advice is not a confirm step');
  assert.ok(!/outside/.test(setup.steps.map((s) => s.type).join()));
});

test('an existing install: old saved settings stay valid and unchanged under the new manifest', () => {
  const { manifest } = loadModule(DIR);
  const old = { address_name: 'hub.example.ts.net', listen_ip: '100.101.102.103', control_port: 9971, agent_port: 9972, run_as: 'service', levels: ['sam:act'], no_ask_agents: [], session_minutes: 45 };
  const safe = safeSettings(manifest, old);
  for (const [k, v] of Object.entries(old)) assert.deepStrictEqual(safe[k], v, k);
  assert.deepStrictEqual(coerceSettings(manifest, {}, old).run_as, 'service');
  for (const run_as of ['auto', 'service', 'hub']) assert.doesNotThrow(() => coerceSettings(manifest, { run_as }, old));
  assert.throws(() => coerceSettings(manifest, { run_as: 'systemd' }, old));
});
