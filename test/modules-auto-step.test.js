'use strict';
// The one-button setup in the module framework: the "auto" step, a precheck on an explain step, suggestions, the manifest rules,
// and the promise that a finished install is left alone. A stand-in module (index.js driven by global.__AUTO) is the connector.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('mod-auto-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const { createModules } = L('modules');
const manifestLib = L('modules/manifest');

const OWNER_ADMIN = { label: 'Run it without an administrator', warning: 'The server then has the same access to files as your Maestro.' };
const MODULE_JSON = {
  id: 'auto-demo', name: 'Auto Demo', category: 'Test', summary: 'A stand-in.', risk: 'read',
  server: { type: 'mcp-stdio', npm: { package: 'fake-srv', version: '1.0.0', bin: 'fake-srv' } },
  settings: [
    { key: 'address_name', type: 'string', label: 'Name', default: '', suggest: 'tailnet_host' },
    { key: 'listen_ip', type: 'string', label: 'Address', default: '', suggest: 'tailnet_ip' },
    { key: 'control_port', type: 'number', label: 'Control port', default: 9971, advanced: true },
    { key: 'agent_port', type: 'number', label: 'Agent port', default: 9972, advanced: true },
    { key: 'run_as', type: 'choice', label: 'Run as', options: ['auto', 'service', 'hub'], default: 'auto', advanced: true },
    { key: 'session_minutes', type: 'number', label: 'Session', default: 30, advanced: true },
  ],
  tools: { peek: 'read' },
};
const SETUP_JSON = { steps: [
  { id: 'about', type: 'explain', title: 'About', body: 'b', precheck: 'prereqs', confirm: 'I understand.' },
  { id: 'setup', type: 'auto', title: 'Set it up', body: 'b', precheck: 'prereqs', install: true, prepare: true, check: 'server', adminChoice: { setting: 'run_as', value: 'hub', ...OWNER_ADMIN } },
  { id: 'done', type: 'finish', title: 'Finish' },
] };
const INDEX_JS = `
const A = () => global.__AUTO;
module.exports = {
  prechecks: { prereqs: async (ctx) => { A().calls.push(['prereqs', ctx]); return A().precheck(ctx); } },
  setup: { prepare: async (ctx) => { A().calls.push(['prepare', ctx]); return A().prepare(ctx); } },
  checks: { server: async (ctx) => { A().calls.push(['server', ctx]); return A().check(ctx); } },
};
`;
const FACTS = (over = {}) => ({ os: 'linux', supported: true, has_systemd: true, hostname: 'box', hub_port: 9970, free_disk_mb: 5000, tailscale: { state: 'running', userspace: false, cli: 'tailscale', host: 'hub.example.ts.net', ips: ['100.101.102.103'], detail: 'Signed in.' }, ...over });

function rig({ facts = FACTS(), saved, finished = false, waitSec, extraSteps = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-'));
  const root = path.join(dir, 'root'), md = path.join(root, 'auto-demo');
  fs.mkdirSync(md, { recursive: true });
  fs.writeFileSync(path.join(md, 'module.json'), JSON.stringify(MODULE_JSON));
  const baseSteps = waitSec === undefined ? SETUP_JSON.steps : SETUP_JSON.steps.map(s => (s.id === 'setup' ? { ...s, waitSec } : s));
  fs.writeFileSync(path.join(md, 'setup.json'), JSON.stringify({ steps: [...baseSteps.slice(0, -1), ...extraSteps, baseSteps[baseSteps.length - 1]] }));
  fs.writeFileSync(path.join(md, 'index.js'), INDEX_JS);
  const stateFile = path.join(dir, 'modules.json');
  if (saved) fs.writeFileSync(stateFile, JSON.stringify(saved));
  const conns = new Map(); const ev = { stops: 0, starts: 0, npm: 0, factsCalls: 0, factsOpts: [], portCalls: [] };
  const connectors = {
    list: () => ({ connectors: [...conns.values()].map(c => ({ ...c, secretNames: [] })) }),
    upsert: (spec) => { const c = { agents: [], ...(conns.get(spec.id) || {}), ...spec }; conns.set(spec.id, c); return c; },
    stop: () => { ev.stops++; }, startBackground: () => { ev.starts++; return []; }, remove: (id) => conns.delete(id), readSecrets: () => ({}),
    callTool: async () => '{}',
  };
  if (finished) conns.set('auto-demo', { id: 'auto-demo', module: 'auto-demo', enabled: true, agents: [] });
  const runNpm = async (args, cwd) => {
    ev.npm++;
    const d = path.join(cwd, 'node_modules', 'fake-srv'); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'fake-srv', version: '1.0.0', bin: { 'fake-srv': 'bin.js' } }));
    fs.writeFileSync(path.join(d, 'bin.js'), '');
    return 'ok';
  };
  const holder = { facts };
  const clock = { t: Date.parse('2026-01-01T00:00:00Z'), sleeps: [] };   // a fake clock: the wait between two looks at a starting server costs no real time
  const mods = createModules({
    now: () => clock.t, sleep: async (ms) => { clock.sleeps.push(ms); clock.t += ms; },
    root, dataDir: path.join(dir, 'modules'), stateFile, connectorsFile: path.join(dir, 'connectors.json'), connectors, listAgents: () => [], publish: () => {}, log: () => {}, runNpm,
    // holder.gate (a promise), when set at the time of a look, holds that look until it settles (a slow look at this computer)
    facts: { get: async (opts) => { ev.factsCalls++; ev.factsOpts.push(opts); const g = holder.gate; if (g) await g; return JSON.parse(JSON.stringify(holder.facts)); } },
    portFree: async (p, h) => { ev.portCalls.push([p, h]); return true; },
  });
  global.__AUTO = { calls: [], precheck: () => ({ ok: true, summary: 'Ready', lines: ['Found this computer: hub.example.ts.net (100.101.102.103).'], blocker: null }), prepare: () => ({ settings: {}, lines: [], choose: null, stop: null }), check: () => ({ ok: true, summary: 'The server is running.', lines: ['up'] }) };
  return { dir, mods, conns, ev, clock, stateFile, holder, auto: global.__AUTO, state: () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')).modules['auto-demo'] : undefined) || {}, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const rejects = async (p) => { try { await p; } catch (e) { return e; } assert.fail('should have been refused'); };
const PREPARE_OK = (ctx) => ({ settings: { address_name: 'hub.example.ts.net', listen_ip: '100.101.102.103', control_port: 9971, agent_port: 9972, run_as: 'auto' }, lines: ['Found this computer.'], choose: null, stop: null });

test('stand-in module loads with no problems: auto step, precheck on explain, suggest and advanced settings', () => {
  const r = rig(); try {
    const m = r.mods.list().find(x => x.id === 'auto-demo');
    assert.notStrictEqual(m.state, 'broken', m.note);
    assert.ok(manifestLib.STEP_TYPES.includes('auto'));
  } finally { r.cleanup(); }
});

test('manifest rules: unknown precheck, prepare without setup.prepare, bad adminChoice, bad suggest or advanced', () => {
  const v = manifestLib.validateManifest(MODULE_JSON, 'auto-demo');
  assert.deepStrictEqual(v.problems, []);
  const hooks = { prechecks: { prereqs: () => ({}) }, setup: { prepare: () => ({}) } };
  const probs = (steps, h = hooks, checks = { server: () => ({}) }) => manifestLib.validateSetup({ steps: [...steps, { id: 'done', type: 'finish', title: 'F' }] }, v, checks, h).join(' | ');
  const auto = { id: 'a', type: 'auto', title: 'A' };
  assert.strictEqual(probs([{ ...auto, precheck: 'prereqs', install: true, prepare: true, check: 'server', adminChoice: { setting: 'run_as', value: 'hub', ...OWNER_ADMIN } }]), '');
  assert.strictEqual(probs([auto]), '', 'every part of an auto step is optional');
  assert.match(probs([{ ...auto, precheck: 'nope' }]), /precheck "nope" is not exported/);
  assert.match(probs([{ id: 'e', type: 'explain', title: 'E', precheck: 'nope' }]), /precheck "nope" is not exported/);
  assert.strictEqual(probs([{ id: 'e', type: 'explain', title: 'E', precheck: 'prereqs' }]), '');
  assert.match(probs([{ ...auto, prepare: true }], { prechecks: hooks.prechecks }), /prepare needs setup\.prepare/);
  assert.match(probs([{ ...auto, check: 'missing' }]), /check "missing" is not exported/);
  assert.strictEqual(probs([{ ...auto, check: 'server', waitSec: 60 }]), '');
  assert.match(probs([{ ...auto, check: 'server', waitSec: 'long' }]), /waitSec must be a number/);
  assert.match(probs([{ ...auto, adminChoice: { setting: 'nope', value: 'hub', ...OWNER_ADMIN } }]), /adminChoice\.setting "nope" is not a setting/);
  assert.match(probs([{ ...auto, adminChoice: { setting: 'run_as', value: 'bogus', ...OWNER_ADMIN } }]), /adminChoice\.value is not valid for setting run_as/);
  assert.match(probs([{ ...auto, adminChoice: { setting: 'run_as', value: 'hub', label: 'x' } }]), /adminChoice\.warning is required/);
  assert.match(probs([{ id: 'c', type: 'outside', title: 'C', precheck: 'prereqs' }]), /only an explain or auto step may name a precheck/);
  const bad = (s) => manifestLib.validateManifest({ ...MODULE_JSON, settings: [{ key: 'x', type: 'string', label: 'X', default: '', ...s }] }, 'auto-demo').problems.join(' | ');
  assert.match(bad({ suggest: 'bogus' }), /suggest must be one of/);
  assert.match(bad({ advanced: 'yes' }), /advanced must be true or false/);
  for (const k of ['tailnet_host', 'tailnet_ip', 'hostname', 'hub_port', 'os', 'has_systemd']) assert.strictEqual(bad({ suggest: k, advanced: true }), '', k);
});

test('a failing precheck stops the auto step before anything runs: e.check carries the answer', async () => {
  const r = rig(); try {
    r.auto.precheck = () => ({ ok: false, summary: "Tailscale isn't installed.", lines: ['Install it from https://tailscale.com/download'], blocker: 'tailscale-missing' });
    const e = await rejects(r.mods.runStep('auto-demo', 'setup', {}));
    assert.deepStrictEqual(e.check, { ok: false, summary: "Tailscale isn't installed.", lines: ['Install it from https://tailscale.com/download'], blocker: 'tailscale-missing' });
    assert.strictEqual(e.message, "Tailscale isn't installed.");
    assert.strictEqual(r.ev.npm, 0, 'nothing was downloaded');
    assert.deepStrictEqual(r.auto.calls.map(c => c[0]), ['prereqs'], 'nothing else ran');
    assert.strictEqual(r.conns.size, 0);
    assert.strictEqual(r.mods.detail('auto-demo').steps.find(s => s.id === 'setup').done, false);
  } finally { r.cleanup(); }
});

test('explain with a precheck refuses while the precheck is not ok, and ctx has facts, the saved settings and the platform', async () => {
  const r = rig(); try {
    r.auto.precheck = () => ({ ok: false, summary: 'Not yet.', lines: [], blocker: 'disk' });
    const e = await rejects(r.mods.runStep('auto-demo', 'about', { confirmed: true }));
    assert.strictEqual(e.check.ok, false); assert.strictEqual(e.check.blocker, 'disk');
    assert.strictEqual(r.mods.detail('auto-demo').steps[0].done, false);
    r.auto.precheck = () => ({ ok: true, summary: 'Ready', lines: [], blocker: null });
    await rejects(r.mods.runStep('auto-demo', 'about', { confirmed: false }));   // the tick box still counts
    const res = await r.mods.runStep('auto-demo', 'about', { confirmed: true });
    assert.strictEqual(res.module.steps[0].done, true);
    const ctx = r.auto.calls.filter(c => c[0] === 'prereqs').pop()[1];
    assert.deepStrictEqual(Object.keys(ctx).sort(), ['facts', 'platform', 'settings']);
    assert.strictEqual(ctx.platform, 'linux'); assert.strictEqual(ctx.facts.tailscale.host, 'hub.example.ts.net');
  } finally { r.cleanup(); }
});

test('precheck(): runs without an install, normalizes the answer, refuses an unknown name; a thrown error is a plain not-ok', async () => {
  const r = rig(); try {
    r.auto.precheck = () => ({ ok: true, summary: 'Ready', lines: ['a', 7], blocker: null, extra: 'x' });
    assert.deepStrictEqual(await r.mods.precheck('auto-demo', 'prereqs'), { ok: true, summary: 'Ready', lines: ['a', '7'], blocker: null });
    assert.strictEqual(r.conns.size, 0, 'no install was needed');
    await rejects(r.mods.precheck('auto-demo', 'nope'));
    await rejects(r.mods.precheck('auto-demo', 'constructor'));
    r.auto.precheck = () => { throw new Error('disk exploded'); };
    assert.deepStrictEqual(await r.mods.precheck('auto-demo', 'prereqs'), { ok: false, summary: 'disk exploded', lines: [], blocker: null });
  } finally { r.cleanup(); }
});

test('auto step, first run: install, prepare fills the empty settings, one restart, check ok; second run changes nothing', async () => {
  const r = rig(); try {
    r.auto.prepare = PREPARE_OK;
    const res = await r.mods.runStep('auto-demo', 'setup', {});
    assert.deepStrictEqual(res.result.lines, ['Downloaded and installed the server.', 'Found this computer.']);
    assert.strictEqual(res.result.check.ok, true);
    assert.strictEqual(res.step, 'setup'); assert.strictEqual(res.module.steps.find(s => s.id === 'setup').done, true);
    assert.strictEqual(r.ev.npm, 1);
    const s = r.state().settings;
    assert.deepStrictEqual({ a: s.address_name, i: s.listen_ip, c: s.control_port, g: s.agent_port, r: s.run_as }, { a: 'hub.example.ts.net', i: '100.101.102.103', c: 9971, g: 9972, r: 'auto' });
    assert.strictEqual(r.ev.stops, 1, 'restarted once for the new settings');
    const before = fs.readFileSync(r.stateFile, 'utf8').replace(/"doneAt": "[^"]*"|"at": "[^"]*"/g, '');
    const again = await r.mods.runStep('auto-demo', 'setup', {});
    assert.deepStrictEqual(again.result.lines, ['Found this computer.'], 'no second download');
    assert.strictEqual(r.ev.npm, 1); assert.strictEqual(r.ev.stops, 1, 'nothing changed, so no restart');
    assert.strictEqual(fs.readFileSync(r.stateFile, 'utf8').replace(/"doneAt": "[^"]*"|"at": "[^"]*"/g, ''), before);
  } finally { r.cleanup(); }
});

test('prepare gets { facts, settings (only what is saved), platform, choices, portFree }', async () => {
  const r = rig({ saved: { modules: { 'auto-demo': { steps: {}, settings: { control_port: 9981, address_name: '', session_minutes: 45 } } } } }); try {
    r.auto.prepare = (ctx) => { assert.ok(typeof ctx.portFree === 'function'); return { settings: {}, lines: [], choose: null, stop: null }; };
    await r.mods.runStep('auto-demo', 'setup', { choices: { listen_ip: '100.101.102.103', bogus: 'x', control_port: { a: 1 } } });
    const ctx = r.auto.calls.find(c => c[0] === 'prepare')[1];
    assert.deepStrictEqual(Object.keys(ctx).sort(), ['choices', 'facts', 'platform', 'portFree', 'saved', 'settings']);
    assert.deepStrictEqual(ctx.settings, { control_port: 9981, session_minutes: 45 }, 'an empty or unsaved setting is absent, so the connector can tell');
    assert.deepStrictEqual(ctx.saved, ctx.settings, 'saved is the same: a saved value equal to its default still counts as saved');
    assert.deepStrictEqual(ctx.choices, { listen_ip: '100.101.102.103' }, 'only real settings with plain values are passed on');
    assert.strictEqual(await ctx.portFree(9971, '127.0.0.1'), true);
    assert.deepStrictEqual(r.ev.portCalls, [[9971, '127.0.0.1']]);
  } finally { r.cleanup(); }
});

test('saved settings are never overwritten by detection', async () => {
  const saved = { modules: { 'auto-demo': { steps: {}, installed: '1.0.0', settings: { address_name: 'mine.example.ts.net', listen_ip: '100.101.102.104', control_port: 9981, agent_port: 9982, run_as: 'service', session_minutes: 45 } } } };
  const r = rig({ saved }); try {
    r.auto.prepare = PREPARE_OK;   // tries to set every one of them
    await r.mods.runStep('auto-demo', 'setup', {});
    assert.deepStrictEqual(r.state().settings, saved.modules['auto-demo'].settings);
    assert.strictEqual(r.ev.stops, 0, 'no setting changed, so no restart');
  } finally { r.cleanup(); }
});

test('an address the connector or the page picks must be one this computer reports as its own', async () => {
  const r = rig(); try {
    r.auto.prepare = () => ({ settings: { listen_ip: '192.0.2.50' }, lines: [], choose: null, stop: null });
    const e = await rejects(r.mods.runStep('auto-demo', 'setup', {}));
    assert.match(e.message, /not this computer's address on your private network/);
    assert.ok(!(r.state().settings || {}).listen_ip, 'nothing was saved');
    r.auto.prepare = () => ({ settings: { listen_ip: '100.64.0.9' }, lines: [], choose: null, stop: null });   // a tailnet address, but not this computer's
    await rejects(r.mods.runStep('auto-demo', 'setup', { choices: { listen_ip: '100.64.0.9' } }));
    r.auto.prepare = () => ({ settings: { address_name: 'other.example.ts.net' }, lines: [], choose: null, stop: null });
    await rejects(r.mods.runStep('auto-demo', 'setup', {}));
    assert.strictEqual(r.ev.stops, 0);
  } finally { r.cleanup(); }
});

test('no Tailscale address on this computer: nothing is merged for the address', async () => {
  const r = rig({ facts: FACTS({ tailscale: { state: 'logged-out', userspace: false, cli: 'tailscale', host: '', ips: [], detail: 'x' } }) }); try {
    r.auto.prepare = () => ({ settings: { listen_ip: '100.101.102.103' }, lines: [], choose: null, stop: null });
    await rejects(r.mods.runStep('auto-demo', 'setup', {}));
    assert.ok(!(r.state().settings || {}).listen_ip);
  } finally { r.cleanup(); }
});

test('stop: the step ends with the connector\'s sentence in e.check, and nothing is saved', async () => {
  const r = rig(); try {
    r.auto.prepare = () => ({ settings: { control_port: 9999 }, lines: ['partial'], choose: null, stop: 'The saved address 100.101.102.104 is not this computer\'s Tailscale address now.' });
    const e = await rejects(r.mods.runStep('auto-demo', 'setup', {}));
    assert.strictEqual(e.message, "The saved address 100.101.102.104 is not this computer's Tailscale address now.");
    assert.deepStrictEqual(e.check, { ok: false, summary: e.message, lines: ['Downloaded and installed the server.', 'partial'], blocker: null });
    assert.ok(!(r.state().settings || {}).control_port);
    assert.strictEqual(r.ev.stops, 0);
  } finally { r.cleanup(); }
});

test('choose: e.choose = { key, label, options: [{ value, label }] }; the answer comes back in choices and is saved', async () => {
  const facts = FACTS({ tailscale: { state: 'running', userspace: false, cli: 'tailscale', host: 'hub.example.ts.net', ips: ['100.101.102.103', '100.101.102.104'], detail: '' } });
  const r = rig({ facts }); try {
    r.auto.prepare = (ctx) => (ctx.choices.listen_ip
      ? { settings: { listen_ip: ctx.choices.listen_ip }, lines: ['Using ' + ctx.choices.listen_ip + '.'], choose: null, stop: null }
      : { settings: { listen_ip: '100.101.102.103' }, lines: [], choose: { key: 'listen_ip', label: 'Which address?', options: [{ value: '100.101.102.103', label: '100.101.102.103' }, { value: '100.101.102.104', label: '100.101.102.104' }] }, stop: null });
    const e = await rejects(r.mods.runStep('auto-demo', 'setup', {}));
    assert.deepStrictEqual(e.choose, { key: 'listen_ip', label: 'Which address?', options: [{ value: '100.101.102.103', label: '100.101.102.103' }, { value: '100.101.102.104', label: '100.101.102.104' }] });
    assert.strictEqual(e.message, 'Which address?');
    assert.ok(!(r.state().settings || {}).listen_ip, 'asking saves nothing');
    const res = await r.mods.runStep('auto-demo', 'setup', { choices: { listen_ip: '100.101.102.104' } });
    assert.strictEqual(r.state().settings.listen_ip, '100.101.102.104');
    assert.ok(res.result.lines.includes('Using 100.101.102.104.'));
    const out = await rejects(r.mods.runStep('auto-demo', 'setup', { choices: { listen_ip: '192.0.2.9' } }));   // even a saved address is only replaced by one of this computer's
    assert.match(out.message, /not this computer's address/);
    assert.strictEqual(r.state().settings.listen_ip, '100.101.102.104');
  } finally { r.cleanup(); }
});

test('a check that fails with a command: e.check and e.admin { command, label, warning, ask: true }; the third choice re-runs with adminChoice', async () => {
  const r = rig(); try {
    // like the connector, prepare words the run mode from what is saved
    const HUB_LINE = "It will run under your Maestro's own account. The server then has the same access to files as your Maestro.";
    r.auto.prepare = (ctx) => ({ settings: ctx.saved.run_as ? {} : { run_as: 'auto' }, lines: ['Found this computer.', ctx.saved.run_as === 'hub' ? HUB_LINE : 'It will run as its own locked-down service.'], choose: null, stop: null });
    r.auto.check = () => ({ ok: false, summary: 'The server could not be started as a service.', lines: ['needs an administrator'], command: 'sudo systemctl start demo' });
    const e = await rejects(r.mods.runStep('auto-demo', 'setup', {}));
    assert.strictEqual(e.check.ok, false);
    assert.strictEqual(e.check.summary, 'The server could not be started as a service.');
    assert.ok(e.check.lines.includes('needs an administrator'));
    assert.deepStrictEqual(e.admin, { command: 'sudo systemctl start demo', label: OWNER_ADMIN.label, warning: OWNER_ADMIN.warning, ask: true });
    assert.strictEqual(r.state().settings.run_as, 'auto');
    assert.strictEqual(r.mods.detail('auto-demo').steps.find(s => s.id === 'setup').done, false);
    const stopsBefore = r.ev.stops;
    r.auto.check = () => ({ ok: true, summary: 'The server is running under your Maestro\'s own account.', lines: [], mode: 'hub' });
    const res = await r.mods.runStep('auto-demo', 'setup', { adminChoice: true });
    assert.strictEqual(r.state().settings.run_as, 'hub');
    assert.ok(r.ev.stops > stopsBefore, 'restarted');
    assert.ok(res.result.lines.includes(HUB_LINE));
    assert.strictEqual(res.result.lines.filter(l => /^It will run/.test(l)).length, 1, 'one "It will run" line, from prepare only');
    assert.ok(!res.result.lines.includes('It will run as its own locked-down service.'), 'never both lines');
    assert.strictEqual(res.module.runMode, 'hub');
    assert.strictEqual(res.module.steps.find(s => s.id === 'setup').done, true);
  } finally { r.cleanup(); }
});

test('the administrator choice is saved (and the server restarted) BEFORE prepare, so prepare plans for the chosen way', async () => {
  const r = rig(); try {
    const seen = [];
    r.auto.prepare = (ctx) => { seen.push({ runAs: ctx.saved.run_as, stops: r.ev.stops }); return { settings: {}, lines: [], choose: null, stop: null }; };
    await r.mods.runStep('auto-demo', 'setup', { adminChoice: true });
    assert.deepStrictEqual(seen, [{ runAs: 'hub', stops: 1 }]);
    const r2 = rig(); try {
      r2.auto.prepare = (ctx) => { seen.push(ctx.saved.run_as); return { settings: {}, lines: [], choose: null, stop: null }; };
      await r2.mods.runStep('auto-demo', 'setup', {});
      assert.strictEqual(seen[1], undefined, 'without the choice nothing is saved before prepare');
    } finally { r2.cleanup(); }
  } finally { r.cleanup(); }
});

test('a check that says retry is looked at again every 5 seconds until it passes; the step then succeeds', async () => {
  const r = rig(); try {
    r.auto.prepare = PREPARE_OK;
    let n = 0;
    r.auto.check = () => (++n < 3 ? { ok: false, retry: true, summary: 'The server is not running.', lines: [] } : { ok: true, summary: 'The server is running.', lines: [] });
    const res = await r.mods.runStep('auto-demo', 'setup', {});
    assert.strictEqual(res.result.check.ok, true);
    assert.strictEqual(n, 3);
    assert.deepStrictEqual(r.clock.sleeps, [5000, 5000]);
    assert.strictEqual(res.module.steps.find(s => s.id === 'setup').done, true);
  } finally { r.cleanup(); }
});

test('a retry that never resolves is not a failure after waitSec (default 180 s): the step is waiting, not done; waitSec on the step changes the wait', async () => {
  const r = rig(); try {
    r.auto.prepare = PREPARE_OK;
    let n = 0;
    r.auto.check = () => ({ ok: false, retry: true, summary: `Still starting ${++n}.`, lines: [] });
    const res = await r.mods.runStep('auto-demo', 'setup', {});
    assert.strictEqual(r.clock.sleeps.length, 36, '180 s in 5 s steps');
    assert.ok(r.clock.sleeps.every(ms => ms === 5000));
    assert.strictEqual(res.result.waiting, true);
    assert.strictEqual(res.result.check.summary, `Still starting ${n}.`);
    assert.strictEqual(res.result.check.retry, true);
    assert.strictEqual(n, 37);
    assert.strictEqual(r.mods.detail('auto-demo').steps.find(s => s.id === 'setup').done, false);
    assert.strictEqual(res.module.steps.find(s => s.id === 'setup').done, false);
  } finally { r.cleanup(); }
  const r2 = rig({ waitSec: 20 }); try {
    r2.auto.prepare = PREPARE_OK;
    r2.auto.check = () => ({ ok: false, retry: true, summary: 'Starting.', lines: [] });
    const res2 = await r2.mods.runStep('auto-demo', 'setup', {});
    assert.strictEqual(res2.result.waiting, true);
    assert.strictEqual(r2.clock.sleeps.length, 4);
  } finally { r2.cleanup(); }
});

test('r3: waiting returns { lines, check, waiting: true } and never marks the step done; a later ok run does', async () => {
  const r = rig(); try {
    r.auto.prepare = (ctx) => ({ ...PREPARE_OK(ctx), lines: ['Found this computer.'] });
    r.auto.check = () => ({ ok: false, retry: true, summary: 'The server is getting ready. This page shows it when it is ready.', lines: ['x'] });
    const res = await r.mods.runStep('auto-demo', 'setup', { poll: true });
    assert.deepStrictEqual(Object.keys(res.result).sort(), ['check', 'lines', 'waiting']);
    assert.strictEqual(res.result.waiting, true);
    assert.ok(res.result.lines.includes('Found this computer.'));
    assert.strictEqual((r.state().steps || {}).setup, undefined, 'markDone was not called');
    r.auto.check = () => ({ ok: true, summary: 'The server is running.', lines: [] });
    const ok = await r.mods.runStep('auto-demo', 'setup', { poll: true });
    assert.ok(!ok.result.waiting);
    assert.ok(r.state().steps.setup && r.state().steps.setup.doneAt);
  } finally { r.cleanup(); }
});

test('r3: a run with poll: true does one check and no wait', async () => {
  const r = rig(); try {
    r.auto.prepare = PREPARE_OK;
    let n = 0;
    r.auto.check = () => { n++; return { ok: false, retry: true, summary: 'Getting ready.', lines: [] }; };
    const res = await r.mods.runStep('auto-demo', 'setup', { poll: true });
    assert.strictEqual(res.result.waiting, true);
    assert.strictEqual(n, 1);
    assert.deepStrictEqual(r.clock.sleeps, []);
    await r.mods.runStep('auto-demo', 'setup', { poll: 'yes' });   // only exactly true counts
    assert.ok(r.clock.sleeps.length > 0);
  } finally { r.cleanup(); }
});

test('r3: check() passes tryAgain through like retry; a tryAgain failure is still a plain failure of the step (no waiting)', async () => {
  const r = rig(); try {
    r.auto.prepare = PREPARE_OK;
    r.auto.check = () => ({ ok: false, tryAgain: true, summary: 'Could not download.', lines: [] });
    const e = await rejects(r.mods.runStep('auto-demo', 'setup', {}));
    assert.strictEqual(e.check.tryAgain, true);
    assert.deepStrictEqual(r.clock.sleeps, []);
    const c = await r.mods.check('auto-demo', 'server');
    assert.strictEqual(c.tryAgain, true);
    assert.ok(!('retry' in c));
    r.auto.check = () => ({ ok: true, tryAgain: true, summary: 'ok', lines: [] });
    assert.ok(!('tryAgain' in await r.mods.check('auto-demo', 'server')));
  } finally { r.cleanup(); }
});

test('a failure without retry (a person is needed, or an error) is reported at once, with no waiting', async () => {
  const r = rig(); try {
    r.auto.prepare = PREPARE_OK;
    r.auto.check = () => ({ ok: false, summary: 'needs a person', lines: [], command: 'sudo x' });
    const e = await rejects(r.mods.runStep('auto-demo', 'setup', {}));
    assert.strictEqual(e.check.summary, 'needs a person');
    assert.ok(e.admin);
    r.auto.check = () => ({ ok: false, retry: 'yes', summary: 'odd', lines: [] });
    await rejects(r.mods.runStep('auto-demo', 'setup', {}));
    assert.deepStrictEqual(r.clock.sleeps, []);
  } finally { r.cleanup(); }
});

test('adminChoice only counts when it is exactly true; any other failure of the check has no e.admin', async () => {
  const r = rig(); try {
    r.auto.prepare = PREPARE_OK;
    r.auto.check = () => ({ ok: false, summary: 'Nothing answers on its port.', lines: [] });
    for (const v of ['true', 1, 'hub', {}]) {
      const e = await rejects(r.mods.runStep('auto-demo', 'setup', { adminChoice: v }));
      assert.strictEqual(e.admin, undefined); assert.strictEqual(e.check.summary, 'Nothing answers on its port.');
    }
    assert.strictEqual(r.state().settings.run_as, 'auto');
  } finally { r.cleanup(); }
});

test('a second one-button run while the first is working is refused', async () => {
  const r = rig(); try {
    let release; const gate = new Promise(res => { release = res; });
    r.auto.prepare = async () => { await gate; return PREPARE_OK(); };
    const first = r.mods.runStep('auto-demo', 'setup', {});
    await new Promise(res => setTimeout(res, 50));
    const e = await rejects(r.mods.runStep('auto-demo', 'setup', {}));
    assert.match(e.message, /already running/);
    release(); await first;
  } finally { r.cleanup(); }
});

test('check(): a server check can say how it runs (mode) and hand back a command; both reach the step, the state and the detail', async () => {
  const r = rig(); try {
    r.auto.prepare = PREPARE_OK;
    await r.mods.runStep('auto-demo', 'setup', {});
    r.auto.check = () => ({ ok: true, summary: 'The server is running as its own locked-down service.', lines: [], mode: 'service' });
    const c = await r.mods.check('auto-demo', 'server');
    assert.strictEqual(c.mode, 'service');
    assert.strictEqual(r.mods.detail('auto-demo').runMode, 'service');
    r.auto.check = () => ({ ok: true, summary: 'fine', lines: [], mode: 'bogus' });
    await r.mods.check('auto-demo', 'server');
    assert.strictEqual(r.mods.detail('auto-demo').runMode, 'service', 'an unknown mode is ignored');
    r.auto.check = () => ({ ok: false, summary: 'down', lines: [], command: 'run this' });
    assert.strictEqual((await r.mods.check('auto-demo', 'server')).command, 'run this');
  } finally { r.cleanup(); }
});

test('suggestions(): only settings with a suggest kind and no saved value; candidates; source', async () => {
  const facts = FACTS({ tailscale: { state: 'running', userspace: false, cli: 'tailscale', host: 'hub.example.ts.net', ips: ['100.101.102.103', '100.101.102.104'], detail: '' } });
  const r = rig({ facts }); try {
    assert.deepStrictEqual(await r.mods.suggestions('auto-demo'), {
      address_name: { value: 'hub.example.ts.net', candidates: ['hub.example.ts.net'], source: 'this computer' },
      listen_ip: { value: '100.101.102.103', candidates: ['100.101.102.103', '100.101.102.104'], source: 'this computer' },
    });
  } finally { r.cleanup(); }
  const r2 = rig({ facts, saved: { modules: { 'auto-demo': { steps: {}, settings: { listen_ip: '100.101.102.104', address_name: '' } } } } }); try {
    const s = await r2.mods.suggestions('auto-demo');
    assert.deepStrictEqual(Object.keys(s), ['address_name'], 'a saved address is never suggested over');
  } finally { r2.cleanup(); }
  const r3 = rig({ facts: FACTS({ tailscale: { state: 'logged-out', userspace: false, cli: '', host: '', ips: [], detail: '' } }) }); try {
    assert.deepStrictEqual(await r3.mods.suggestions('auto-demo'), {}, 'nothing detected, nothing offered');
  } finally { r3.cleanup(); }
});

test('an install that is already set up (old step ids, finishedAt, saved settings) loads as finished and nothing changes, restarts or is detected', async () => {
  const saved = { modules: { 'auto-demo': {
    steps: { intro: { doneAt: '2026-01-01T00:00:00.000Z' }, install: { doneAt: '2026-01-01T00:00:00.000Z' }, check: { doneAt: '2026-01-01T00:00:00.000Z' } },
    installed: '1.0.0', finishedAt: '2026-01-02T00:00:00.000Z',
    settings: { address_name: 'old.example.ts.net', listen_ip: '100.101.102.105', control_port: 9971, agent_port: 9972, run_as: 'service', session_minutes: 30 },
    lastCheck: { ok: true, summary: 'ok', lines: [], warnings: [], ackRequired: null, at: '2026-01-02T00:00:00.000Z' },
  } } };
  const r = rig({ saved, finished: true }); try {
    const before = fs.readFileSync(r.stateFile, 'utf8');
    const m = r.mods.detail('auto-demo');
    assert.ok(m.finishedAt);
    assert.strictEqual(m.settings.run_as, 'service');
    assert.strictEqual(m.state === 'broken', false);
    assert.strictEqual(r.mods.list().find(x => x.id === 'auto-demo').state === 'setup', false, 'not shown as set-up-in-progress');
    assert.deepStrictEqual(await r.mods.suggestions('auto-demo'), {}, 'a finished setup is offered nothing');
    r.mods.syncConnectors(); r.mods.readinessItems();
    assert.strictEqual(r.ev.factsCalls, 0, 'nothing was detected');
    assert.strictEqual(r.ev.stops, 0, 'no restart'); assert.strictEqual(r.ev.npm, 0);
    assert.strictEqual(r.auto.calls.length, 0, 'no step, check or hook ran');
    assert.strictEqual(fs.readFileSync(r.stateFile, 'utf8'), before, 'the state file is byte for byte the same');
  } finally { r.cleanup(); }
});

test('the existing step types still work beside the new one (settings step, finish)', async () => {
  const r = rig(); try {
    r.auto.prepare = PREPARE_OK;
    await r.mods.runStep('auto-demo', 'about', { confirmed: true });
    await r.mods.runStep('auto-demo', 'setup', {});
    const fin = await r.mods.runStep('auto-demo', 'done', {});
    assert.ok(fin.module.finishedAt);
    r.mods.saveSettings('auto-demo', { session_minutes: 40 });
    assert.strictEqual(r.state().settings.session_minutes, 40);
  } finally { r.cleanup(); }
});

// ── the hub's routes (server.js) ──
test('routes: precheck and suggestions refuse the hub service and members, and e.choose / e.admin reach the page', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const i = server.indexOf("/(?:precheck\\/(");
  assert.ok(i > 0, 'the routes exist');
  const block = server.slice(i, i + 900);
  assert.match(block, /req\.method === 'GET'/);
  assert.match(block, /req\.hubService \|\| \(req\.hubUser && !access\.isAdmin\(req\.hubUser\)\)\) return jsonResponse\(res, 403/);
  assert.match(block, /mods\.precheck\(m\[1\], m\[2\], \{ fresh: new URL\(req\.url, 'http:\/\/x'\)\.searchParams\.get\('fresh'\) === '1' \}\)/);
  assert.match(block, /\{ suggestions: await mods\.suggestions\(m\[1\]\) \}/);
  const fail = /const fail = \(e\) => [^\n]*/.exec(server)[0];
  assert.match(fail, /e\.choose \? \{ choose: e\.choose \}/);
  assert.match(fail, /e\.admin \? \{ admin: e\.admin \}/);
  assert.match(fail, /e\.check \? \{ check: e\.check \}/);
  // the changes made through step stay behind the existing refusal of the service identity
  assert.match(server, /req\.method !== 'GET' && req\.hubService\) return jsonResponse\(res, 403, \{ error: 'Module changes need a signed-in admin\.'/);
  assert.match(server, /const saved = await mods\.saveSettings\(id, b\.values \|\| \{\}\)/);
});

// ── review round 1: every save path checks the listen address ──
const SETTINGS_STEP = { id: 'sett', type: 'settings', title: 'Settings', fields: ['address_name', 'listen_ip', 'session_minutes'] };
const asPromise = (fn) => Promise.resolve().then(fn);   // saveSettings may answer at once or after a look at this computer
const NOT_OWN = /not this computer's address on your private network\.$/;

test('Advanced / overview save (saveSettings): a LAN address is refused with the plain sentence and nothing is saved; a candidate is accepted', async () => {
  const r = rig(); try {
    const e = await rejects(asPromise(() => r.mods.saveSettings('auto-demo', { listen_ip: '192.0.2.20', session_minutes: 50 })));
    assert.strictEqual(e.message, 'Address: 192.0.2.20 is not this computer\'s address on your private network.');
    assert.ok(!(r.state().settings || {}).listen_ip, 'nothing was saved');
    assert.ok(!(r.state().settings || {}).session_minutes, 'not even the other setting in the same save');
    assert.strictEqual(r.ev.stops, 0, 'no restart');
    await rejects(asPromise(() => r.mods.saveSettings('auto-demo', { listen_ip: '100.64.0.9' })));   // a tailnet address, but not this computer's
    await rejects(asPromise(() => r.mods.saveSettings('auto-demo', { address_name: 'other.example.ts.net' })));
    const ok = await r.mods.saveSettings('auto-demo', { listen_ip: '100.101.102.103', address_name: 'hub.example.ts.net', session_minutes: 50 });
    assert.strictEqual(ok.settings.listen_ip, '100.101.102.103');
    assert.deepStrictEqual([r.state().settings.listen_ip, r.state().settings.address_name, r.state().settings.session_minutes], ['100.101.102.103', 'hub.example.ts.net', 50]);
    assert.ok(r.ev.factsOpts.every(o => o && o.fresh === true), 'it looks at this computer afresh when it matters');
  } finally { r.cleanup(); }
});

// review r2: a save that waits for the address check applies only its own changed fields, onto the settings as they are then
const held = (r) => { let open; r.holder.gate = new Promise((res) => { open = res; }); return () => { r.holder.gate = null; open(); }; };
const TWO_IPS = () => FACTS({ tailscale: { state: 'running', userspace: false, cli: 'tailscale', host: 'hub.example.ts.net', ips: ['100.101.102.103', '100.101.102.104'], detail: '' } });

test('r2: a port saved by someone else while an address save waits for its check survives', async () => {
  const r = rig(); try {
    const release = held(r);
    const a = Promise.resolve(r.mods.saveSettings('auto-demo', { listen_ip: '100.101.102.103', control_port: 9971 }));   // started now: its changes are decided at once
    r.holder.gate = null;   // the second save changes no address: it is not held
    await r.mods.saveSettings('auto-demo', { control_port: 9100 });
    release();
    await a;
    assert.deepStrictEqual([r.state().settings.listen_ip, r.state().settings.control_port], ['100.101.102.103', 9100], 'the first save did not put the old port back');
  } finally { r.cleanup(); }
});

test('r2: a stale form never puts back an address it did not change', async () => {
  const saved = { modules: { 'auto-demo': { steps: {}, settings: { listen_ip: '192.0.2.5', address_name: '' } } } };
  const r = rig({ saved }); try {
    const release = held(r);
    // admin A changes only the name; the form still carries the old (LAN) listen address, unchanged
    const a = Promise.resolve(r.mods.saveSettings('auto-demo', { address_name: 'hub.example.ts.net', listen_ip: '192.0.2.5' }));   // started now: its changes are decided at once
    r.holder.gate = null;
    // admin B corrects the listen address meanwhile
    await r.mods.saveSettings('auto-demo', { listen_ip: '100.101.102.103' });
    release();
    await a;
    assert.deepStrictEqual([r.state().settings.listen_ip, r.state().settings.address_name], ['100.101.102.103', 'hub.example.ts.net']);
  } finally { r.cleanup(); }
});

test('r2: two people changing the same field at once: the later one is refused with a plain sentence, nothing of it is saved', async () => {
  const r = rig({ facts: TWO_IPS() }); try {
    const release = held(r);
    const a = Promise.resolve(r.mods.saveSettings('auto-demo', { listen_ip: '100.101.102.103', session_minutes: 50 }));   // started now: its changes are decided at once
    r.holder.gate = null;
    await r.mods.saveSettings('auto-demo', { listen_ip: '100.101.102.104' });
    release();
    const e = await rejects(a);
    assert.match(e.message, /^Address was changed by someone else meanwhile\. Open the page again and check before saving\.$/);
    assert.strictEqual(r.state().settings.listen_ip, '100.101.102.104');
    assert.ok(!r.state().settings.session_minutes || r.state().settings.session_minutes !== 50, 'nothing of the refused save');
  } finally { r.cleanup(); }
});

test('a changed saved address is checked too (replacing a saved one with a LAN address is refused)', async () => {
  const saved = { modules: { 'auto-demo': { steps: {}, settings: { listen_ip: '100.101.102.103', address_name: 'hub.example.ts.net' } } } };
  const r = rig({ saved }); try {
    const e = await rejects(asPromise(() => r.mods.saveSettings('auto-demo', { listen_ip: '10.0.0.5' })));
    assert.match(e.message, NOT_OWN);
    assert.strictEqual(r.state().settings.listen_ip, '100.101.102.103');
  } finally { r.cleanup(); }
});

test('an unchanged saved address is never checked: an existing install saves another setting while Tailscale is down', async () => {
  const saved = { modules: { 'auto-demo': { steps: {}, installed: '1.0.0', settings: { listen_ip: '100.101.102.104', address_name: 'old.example.ts.net', session_minutes: 30 } } } };
  const down = FACTS({ tailscale: { state: 'not-running', userspace: false, cli: 'tailscale', host: '', ips: [], detail: 'x' } });
  const r = rig({ saved, facts: down }); try {
    const d = r.mods.saveSettings('auto-demo', { listen_ip: '100.101.102.104', address_name: 'old.example.ts.net', session_minutes: 45 });
    assert.strictEqual((await d).settings.session_minutes, 45);
    assert.deepStrictEqual([r.state().settings.listen_ip, r.state().settings.address_name], ['100.101.102.104', 'old.example.ts.net']);
    assert.strictEqual(r.ev.factsCalls, 0, 'this computer was not even looked at');
    // the same through the page's whole-form save, where every field comes back as text
    await r.mods.saveSettings('auto-demo', { listen_ip: '100.101.102.104', session_minutes: '50' });
    assert.strictEqual(r.state().settings.session_minutes, 50);
    assert.strictEqual(r.ev.factsCalls, 0);
    // an emptied address is not an address and is not checked
    await r.mods.saveSettings('auto-demo', { address_name: '' });
    assert.strictEqual(r.ev.factsCalls, 0);
  } finally { r.cleanup(); }
});

test('the settings step checks a changed address the same way, and leaves unchanged ones alone', async () => {
  const r = rig({ extraSteps: [SETTINGS_STEP] }); try {
    const e = await rejects(r.mods.runStep('auto-demo', 'sett', { values: { listen_ip: '192.0.2.20' } }));
    assert.match(e.message, NOT_OWN);
    assert.ok(!(r.state().settings || {}).listen_ip);
    const res = await r.mods.runStep('auto-demo', 'sett', { values: { listen_ip: '100.101.102.103', address_name: 'hub.example.ts.net' } });
    assert.strictEqual(res.result.settings.listen_ip, '100.101.102.103');
    assert.strictEqual(r.state().settings.listen_ip, '100.101.102.103');
  } finally { r.cleanup(); }
  const saved = { modules: { 'auto-demo': { steps: {}, settings: { listen_ip: '100.101.102.104' } } } };
  const down = FACTS({ tailscale: { state: 'logged-out', userspace: false, cli: 'tailscale', host: '', ips: [], detail: 'x' } });
  const r2 = rig({ saved, facts: down, extraSteps: [SETTINGS_STEP] }); try {
    await r2.mods.runStep('auto-demo', 'sett', { values: { listen_ip: '100.101.102.104', session_minutes: 40 } });
    assert.strictEqual(r2.state().settings.session_minutes, 40);
    assert.strictEqual(r2.ev.factsCalls, 0);
  } finally { r2.cleanup(); }
});

// ── review round 1: follow-ups ──
test('runAuto: the administrator choice is applied (and the server restarted) only when it differs from what is saved', async () => {
  const saved = { modules: { 'auto-demo': { steps: {}, installed: '1.0.0', settings: { run_as: 'hub', listen_ip: '100.101.102.103', address_name: 'hub.example.ts.net' } } } };
  const r = rig({ saved }); try {
    await r.mods.runStep('auto-demo', 'setup', { adminChoice: true });
    assert.strictEqual(r.ev.stops, 0, 'already saved as hub: no restart');
    assert.strictEqual(r.state().settings.run_as, 'hub');
  } finally { r.cleanup(); }
  const r2 = rig(); try {
    await r2.mods.runStep('auto-demo', 'setup', { adminChoice: true });
    assert.strictEqual(r2.ev.stops, 1, 'a different value is saved with one restart');
    assert.strictEqual(r2.state().settings.run_as, 'hub');
    await r2.mods.runStep('auto-demo', 'setup', { adminChoice: true });
    assert.strictEqual(r2.ev.stops, 1, 'asked again: nothing differs now');
  } finally { r2.cleanup(); }
});

test('precheck({ fresh: true }) asks for a fresh look at this computer; an ordinary precheck does not', async () => {
  const r = rig(); try {
    await r.mods.precheck('auto-demo', 'prereqs');
    await r.mods.precheck('auto-demo', 'prereqs', { fresh: true });
    await r.mods.precheck('auto-demo', 'prereqs', { fresh: false });
    assert.deepStrictEqual(r.ev.factsOpts, [undefined, { fresh: true }, undefined]);
  } finally { r.cleanup(); }
});
