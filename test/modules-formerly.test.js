'use strict';
// Steps done under an earlier name ("formerly" in setup.json), and "Set it up" on a setup that is already finished.
// The real remote-computers module is loaded (its index.js, setup.json and module.json, minus the npm runtime that is never run here);
// the connector, the facts about this computer and the free-port probe are stand-ins.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('mod-formerly-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const { createModules } = L('modules');
const manifestLib = L('modules/manifest');

const REAL_DIR = path.join(__dirname, '..', 'modules', 'remote-computers');
const OLD_IDS = ['about', 'install', 'prefs', 'server', 'pc', 'installer', 'computer', 'levels', 'agents', 'done'];
const FACTS = { os: 'linux', supported: true, has_systemd: true, hostname: 'box', hub_port: 9970, free_disk_mb: 5000, tailscale: { state: 'running', userspace: false, cli: 'tailscale', host: 'hub.example.ts.net', ips: ['100.101.102.103'], detail: 'Signed in.' } };
const HEALTH = JSON.stringify({ ok: true, running: true, group: true, mode: 'hub', computers: 0, online: 0, warnings: [] });

function rig({ saved, health = HEALTH, facts = FACTS }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'formerly-'));
  const root = path.join(dir, 'root'), md = path.join(root, 'remote-computers');
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(REAL_DIR, md, { recursive: true });
  const mj = JSON.parse(fs.readFileSync(path.join(md, 'module.json'), 'utf8'));
  delete mj.runtime;   // nothing is downloaded here
  fs.writeFileSync(path.join(md, 'module.json'), JSON.stringify(mj));
  const stateFile = path.join(dir, 'modules.json');
  fs.writeFileSync(stateFile, JSON.stringify({ modules: { 'remote-computers': saved } }));
  const conns = new Map(); const ev = { stops: 0, starts: 0, ports: [] };
  conns.set('remote-computers', { id: 'remote-computers', module: 'remote-computers', enabled: true, agents: [] });
  const connectors = {
    list: () => ({ connectors: [...conns.values()].map(c => ({ ...c, secretNames: [] })) }),
    upsert: (spec) => { const c = { agents: [], ...(conns.get(spec.id) || {}), ...spec }; conns.set(spec.id, c); return c; },
    stop: () => { ev.stops++; }, startBackground: () => { ev.starts++; return []; }, remove: (id) => conns.delete(id), readSecrets: () => ({}),
    callTool: async () => health,
  };
  const mods = createModules({
    root, dataDir: path.join(dir, 'modules'), stateFile, connectorsFile: path.join(dir, 'connectors.json'), connectors, listAgents: () => [], publish: () => {}, log: () => {},
    facts: { get: async () => JSON.parse(JSON.stringify(facts)) },
    // its own server holds both ports
    portFree: async (p, h) => { ev.ports.push([p, h]); return false; },
  });
  return { dir, mods, ev, stateFile, raw: () => fs.readFileSync(stateFile, 'utf8'), state: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')).modules['remote-computers'], cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const doneMap = (ids, base = '2026-11-20T10:00:00.000Z') => Object.fromEntries(ids.map((id, i) => [id, { doneAt: new Date(Date.parse(base) + i * 60000).toISOString() }]));
const SAVED_SETTINGS = { address_name: 'hub.example.ts.net', listen_ip: '100.101.102.103', control_port: 9971, agent_port: 9972 };   // no run_as

test('manifest: formerly is optional; a list of 1 to 10 non-empty strings, none a current step of the module', () => {
  const v = manifestLib.validateManifest(JSON.parse(fs.readFileSync(path.join(REAL_DIR, 'module.json'), 'utf8')), 'remote-computers');
  const hooks = { prechecks: { prereqs: () => ({}) }, setup: { prepare: () => ({}) } };
  const probs = (formerly) => manifestLib.validateSetup({ steps: [
    { id: 'a', type: 'explain', title: 'A' },
    { id: 'b', type: 'outside', title: 'B', ...(formerly === undefined ? {} : { formerly }) },
    { id: 'done', type: 'finish', title: 'F' },
  ] }, v, { server: () => ({}) }, hooks).join(' | ');
  assert.strictEqual(probs(undefined), '');
  assert.strictEqual(probs(['x']), '');
  assert.strictEqual(probs(['x', 'y', 'z', 'old-1', 'old-2', 'old-3', 'old-4', 'old-5', 'old-6', 'old-7']), '', 'ten is allowed');
  assert.match(probs('x'), /step b: formerly must be a list/);
  assert.match(probs({ 0: 'x' }), /step b: formerly must be a list/);
  assert.match(probs([]), /step b: formerly must be a list/);
  assert.match(probs(['x', '']), /step b: formerly must be a list/);
  assert.match(probs(['x', '   ']), /step b: formerly must be a list/);
  assert.match(probs(['x', 7]), /step b: formerly must be a list/);
  assert.match(probs(['x', 'y', 'z', 'old-1', 'old-2', 'old-3', 'old-4', 'old-5', 'old-6', 'old-7', 'old-8']), /step b: formerly must be a list of 1 to 10/);
  assert.match(probs(['a']), /step b: formerly "a" is a current step of this module/);
  assert.match(probs(['x', 'b']), /step b: formerly "b" is a current step of this module/);
  assert.match(probs(['done']), /formerly "done" is a current step/);
});

test('the real remote-computers setup names the steps it replaced, and still loads without problems', () => {
  const setup = JSON.parse(fs.readFileSync(path.join(REAL_DIR, 'setup.json'), 'utf8'));
  assert.deepStrictEqual(setup.steps.find(s => s.id === 'setup').formerly, ['install', 'prefs', 'server']);
  assert.deepStrictEqual(setup.steps.find(s => s.id === 'add').formerly, ['pc', 'installer']);
  const r = rig({ saved: { settings: {}, steps: {} } }); try {
    const m = r.mods.list().find(x => x.id === 'remote-computers');
    assert.notStrictEqual(m.state, 'broken', m.note);
  } finally { r.cleanup(); }
});

test('status: a setup saved under the old step list shows every current step done, each with a doneAt', () => {
  const steps = doneMap(OLD_IDS);
  const r = rig({ saved: { settings: SAVED_SETTINGS, steps, installed: 'script', finishedAt: '2026-11-20T11:00:00.000Z' } }); try {
    const d = r.mods.detail('remote-computers');
    assert.deepStrictEqual(d.steps.map(s => s.id), ['about', 'setup', 'add', 'computer', 'agents', 'done']);
    for (const s of d.steps) { assert.strictEqual(s.done, true, s.id); assert.ok(typeof s.doneAt === 'string' && s.doneAt, `${s.id} has a doneAt`); }
    assert.strictEqual(d.steps.find(s => s.id === 'setup').doneAt, steps.server.doneAt, 'the latest of install, prefs and server');
    assert.strictEqual(d.steps.find(s => s.id === 'add').doneAt, steps.installer.doneAt, 'the latest of pc and installer');
    assert.strictEqual(d.steps.find(s => s.id === 'about').doneAt, steps.about.doneAt, 'a step that kept its id is untouched');
  } finally { r.cleanup(); }
});

test('status: a step that has its own record uses its own doneAt, not the earlier ones', () => {
  const steps = { ...doneMap(OLD_IDS), setup: { doneAt: '2026-11-22T09:00:00.000Z' } };
  const r = rig({ saved: { settings: SAVED_SETTINGS, steps, installed: 'script' } }); try {
    assert.strictEqual(r.mods.detail('remote-computers').steps.find(s => s.id === 'setup').doneAt, '2026-11-22T09:00:00.000Z');
  } finally { r.cleanup(); }
});

test('status: only install and prefs done (no server) leaves "Set it up" not done, and it is the next step', () => {
  const r = rig({ saved: { settings: {}, steps: doneMap(['about', 'install', 'prefs']) } }); try {
    const d = r.mods.detail('remote-computers');
    const setup = d.steps.find(s => s.id === 'setup');
    assert.strictEqual(setup.done, false); assert.strictEqual(setup.doneAt, null);
    assert.strictEqual(d.steps.find(s => s.id === 'add').done, false);
    assert.strictEqual(d.steps.find(s => s.id === 'about').done, true);
    const item = r.mods.list().find(x => x.id === 'remote-computers');
    assert.strictEqual(item.next, 'setup');
  } finally { r.cleanup(); }
});

test('finishing: with every old step done the finish check sees no open step; with the server step missing it names "Set it up"', async () => {
  const ok = rig({ saved: { settings: SAVED_SETTINGS, steps: doneMap(OLD_IDS.filter(x => x !== 'done')), installed: 'script' } }); try {
    const item = ok.mods.list().find(x => x.id === 'remote-computers');
    assert.strictEqual(item.next, 'done', 'nothing is left but the finish');
    await ok.mods.runStep('remote-computers', 'done', {});
    assert.ok(ok.state().finishedAt, 'it finished');
  } finally { ok.cleanup(); }
  const bad = rig({ saved: { settings: SAVED_SETTINGS, steps: doneMap(OLD_IDS.filter(x => x !== 'done' && x !== 'server')), installed: 'script' } }); try {
    await assert.rejects(bad.mods.runStep('remote-computers', 'done', {}), /Not finished yet: Set it up\./);
  } finally { bad.cleanup(); }
});

test('"Set it up" on a finished setup (old install, no run_as saved): the saved settings stay byte for byte, no restart, nothing to choose, no administrator question', async () => {
  const r = rig({ saved: { settings: SAVED_SETTINGS, steps: doneMap(OLD_IDS), installed: 'script', finishedAt: '2026-11-20T11:00:00.000Z' } }); try {
    const settingsBefore = JSON.stringify(r.state().settings);
    const res = await r.mods.runStep('remote-computers', 'setup', {});
    assert.ok(res && res.ok !== false);
    assert.strictEqual(JSON.stringify(r.state().settings), settingsBefore, 'the settings are exactly as they were');
    assert.ok(!Object.prototype.hasOwnProperty.call(r.state().settings, 'run_as'), 'run_as was not written');
    assert.strictEqual(r.ev.stops, 0, 'the server was not restarted for settings');
    assert.strictEqual(r.ev.starts, 0);
    assert.ok(!('choose' in res) && !('admin' in res) && !(res.result && ('choose' in res.result || 'admin' in res.result)), 'no choose and no admin in the answer');
    assert.deepStrictEqual(r.ev.ports, [], 'saved ports are not probed again');
  } finally { r.cleanup(); }
});

test('"Set it up" on an UNFINISHED setup with the same saved settings and no run_as still fills run_as in, and restarts for it (today\'s behaviour)', async () => {
  const r = rig({ saved: { settings: SAVED_SETTINGS, steps: doneMap(['about']), installed: 'script' } }); try {
    assert.ok(!r.state().finishedAt);
    await r.mods.runStep('remote-computers', 'setup', {});
    assert.strictEqual(r.state().settings.run_as, 'auto');
    assert.strictEqual(r.state().settings.control_port, 9971);
    assert.strictEqual(r.ev.stops, 1, 'restarted once for the new setting');
  } finally { r.cleanup(); }
});

test('"Set it up" on a finished setup: a value the person just answered is still written', async () => {
  const r = rig({ saved: { settings: SAVED_SETTINGS, steps: doneMap(OLD_IDS), installed: 'script', finishedAt: '2026-11-20T11:00:00.000Z' } }); try {
    await r.mods.runStep('remote-computers', 'setup', { choices: { run_as: 'hub' } });
    assert.strictEqual(r.state().settings.run_as, 'hub');
    assert.strictEqual(r.state().settings.listen_ip, '100.101.102.103');
  } finally { r.cleanup(); }
});

test('"Set it up" on a finished setup: an effectively empty setting (no saved address) is still detected and filled in', async () => {
  const saved = { address_name: '', listen_ip: '', control_port: 9971, agent_port: 9972 };
  const r = rig({ saved: { settings: saved, steps: doneMap(OLD_IDS), installed: 'script', finishedAt: '2026-11-20T11:00:00.000Z' } }); try {
    await r.mods.runStep('remote-computers', 'setup', {});
    assert.strictEqual(r.state().settings.listen_ip, '100.101.102.103');
    assert.strictEqual(r.state().settings.address_name, 'hub.example.ts.net');
  } finally { r.cleanup(); }
});

test('the administrator question carries the name of the computer Maestro runs on: its Tailscale name, else its hostname, else null', async () => {
  const needsAdmin = JSON.stringify({ reason: 'not-installed', message: 'The service is not installed.', command: 'sudo install-it', ok: false });
  const ask = async (facts) => {
    const r = rig({ saved: { settings: SAVED_SETTINGS, steps: doneMap(['about']), installed: 'script' }, health: needsAdmin, facts }); try {
      try { await r.mods.runStep('remote-computers', 'setup', {}); } catch (e) { return e.admin; }
      assert.fail('the setup should have asked for an administrator');
    } finally { r.cleanup(); }
  };
  const a = await ask(FACTS);
  assert.strictEqual(a.command, 'sudo install-it'); assert.strictEqual(a.ask, true);
  assert.strictEqual(a.computer, 'hub.example.ts.net');
  assert.strictEqual((await ask({ ...FACTS, tailscale: { ...FACTS.tailscale, host: '' } })).computer, 'box', 'no Tailscale name: the hostname');
  assert.strictEqual((await ask({ ...FACTS, hostname: '', tailscale: { ...FACTS.tailscale, host: null } })).computer, null, 'no name at all');
});
