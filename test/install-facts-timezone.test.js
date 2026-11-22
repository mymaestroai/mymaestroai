'use strict';
// The time_zone install fact, and Ring's time zone being filled in from this computer.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('install-facts-tz-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const { createInstallFacts, suggestFor, SUGGEST_KINDS } = L('install-facts');
const { createModules } = L('modules');
const manifestLib = L('modules/manifest');

const noCli = async () => ({ code: 'ENOENT', stdout: '', stderr: '', missing: true });
const facts = (timeZone) => createInstallFacts({ platform: 'linux', run: noCli, env: {}, dataDir: os.tmpdir(), hostname: () => 'office-pc', timeZone }).get();

test('time_zone is read from the injected zone', async () => {
  assert.strictEqual((await facts(() => 'America/New_York')).time_zone, 'America/New_York');
  assert.strictEqual((await facts(() => 'UTC')).time_zone, 'UTC', 'UTC when that is what the computer says');
});

test('time_zone is empty when the zone is unknown or cannot be read', async () => {
  assert.strictEqual((await facts(() => '')).time_zone, '');
  assert.strictEqual((await facts(() => undefined)).time_zone, '');
  assert.strictEqual((await facts(() => { throw new Error('no zone'); })).time_zone, '');
});

test('without an injected zone the computer\'s own zone is used', async () => {
  const f = await createInstallFacts({ platform: 'linux', run: noCli, env: {}, dataDir: os.tmpdir() }).get();
  assert.strictEqual(f.time_zone, String(Intl.DateTimeFormat().resolvedOptions().timeZone || ''));
});

test('suggestFor("time_zone") offers the zone, or nothing when empty; other kinds are unchanged', async () => {
  assert.ok(SUGGEST_KINDS.includes('time_zone'));
  assert.deepStrictEqual(suggestFor('time_zone', { time_zone: 'Europe/London' }), { value: 'Europe/London', candidates: ['Europe/London'] });
  assert.strictEqual(suggestFor('time_zone', { time_zone: '' }), null);
  assert.strictEqual(suggestFor('time_zone', {}), null);
  assert.strictEqual(suggestFor('time_zone', { time_zone: 5 }), null);
  assert.deepStrictEqual(suggestFor('hostname', { hostname: 'office-pc', time_zone: 'UTC' }), { value: 'office-pc', candidates: ['office-pc'] });
  assert.deepStrictEqual(suggestFor('hub_port', { hub_port: 8888 }), { value: 8888, candidates: [8888] });
});

test('the Ring manifest and setup validate, with time_zone suggested and the optional fields under Advanced', () => {
  const dir = path.join(__dirname, '..', 'modules', 'ring');
  const mf = JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf8'));
  const setup = JSON.parse(fs.readFileSync(path.join(dir, 'setup.json'), 'utf8'));
  assert.deepStrictEqual(manifestLib.validateManifest(mf, 'ring').problems, []);
  const def = (k) => mf.settings.find(s => s.key === k);
  assert.strictEqual(def('time_zone').suggest, 'time_zone');
  for (const k of ['houses', 'faces_url', 'faces_seen', 'still_days', 'still_quota_mb', 'clip_days', 'clip_quota_mb', 'faces_quota_mb']) assert.strictEqual(def(k).advanced, true, k);
  const prefs = setup.steps.find(s => s.id === 'prefs');
  assert.ok(!/and your time zone \(for example/i.test(prefs.body), 'no longer asks the person to type the zone');
  assert.match(prefs.body, /filled in from this computer/);
});

function rig(saved, zone) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-tz-'));
  const stateFile = path.join(dir, 'modules.json');
  if (saved) fs.writeFileSync(stateFile, JSON.stringify(saved));
  const connectors = { list: () => ({ connectors: [] }), upsert: () => ({}), stop() {}, startBackground: () => [], remove() {}, readSecrets: () => ({}), callTool: async () => '{}' };
  const mods = createModules({
    now: () => Date.parse('2026-01-01T00:00:00Z'), root: path.join(__dirname, '..', 'modules'), dataDir: path.join(dir, 'modules'), stateFile,
    connectorsFile: path.join(dir, 'connectors.json'), connectors, listAgents: () => [], publish: () => {}, log: () => {},
    facts: { get: async () => ({ os: 'linux', supported: true, has_systemd: true, hostname: 'office-pc', hub_port: 8888, free_disk_mb: 5000, time_zone: zone, tailscale: { state: 'not-installed', userspace: false, cli: '', host: '', ips: [], detail: '' } }) },
  });
  return { mods, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the page suggestion path offers time_zone for Ring when nothing is saved, and nothing when a zone is saved', async () => {
  const a = rig(null, 'America/New_York'); try {
    assert.deepStrictEqual(await a.mods.suggestions('ring'), { time_zone: { value: 'America/New_York', candidates: ['America/New_York'], source: 'this computer' } });
  } finally { a.cleanup(); }
  const b = rig({ modules: { ring: { steps: {}, settings: { time_zone: 'Europe/London' } } } }, 'America/New_York'); try {
    assert.deepStrictEqual(await b.mods.suggestions('ring'), {});
  } finally { b.cleanup(); }
  const c = rig(null, ''); try {
    assert.deepStrictEqual(await c.mods.suggestions('ring'), {}, 'an unknown zone offers nothing');
  } finally { c.cleanup(); }
});

test('Ring: the time zone default is empty, so the page fills it in from this computer; an empty zone still means UTC', () => {
  const path = require('path');
  const mj = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'modules', 'ring', 'module.json'), 'utf8'));
  const tz = mj.settings.find((s) => s.key === 'time_zone');
  assert.strictEqual(tz.default, '', 'the page fills only an empty box (fillSuggestions), so a default of UTC would hide the suggestion');
  assert.throws(() => new Intl.DateTimeFormat('en-US', { timeZone: '' }), RangeError, 'Ring falls back to UTC when the zone is refused');
});
