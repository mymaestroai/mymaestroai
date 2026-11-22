'use strict';
// The rule for module authors: setup.prepare may be asked twice (before and after the download), so it only looks and returns.
// Guard test: it passes on the code as it is today and keeps it so for every shipped module.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULES = path.join(__dirname, '..', 'modules');

const FACTS = () => ({ os: 'linux', supported: true, has_systemd: true, hostname: 'office-pc', hub_port: 8888, free_disk_mb: 50000, time_zone: 'America/New_York', tailscale: { state: 'running', userspace: false, cli: 'tailscale', host: 'hub.example.ts.net', ips: ['100.64.0.10'], detail: 'Signed in.' } });

function listTree(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); out.push(p); if (e.isDirectory()) walk(p); } };
  walk(dir);
  return out.sort();
}
const snapshot = (dir) => listTree(dir).map((p) => `${p}:${fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : ''}`);

const shipped = fs.readdirSync(MODULES, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(MODULES, e.name, 'index.js')));
const withPrepare = shipped.filter((e) => { const m = require(path.join(MODULES, e.name, 'index.js')); return m && m.setup && typeof m.setup.prepare === 'function'; });

test('at least one shipped module has setup.prepare (so this guard is not empty)', () => {
  assert.ok(withPrepare.length >= 1);
});

for (const e of withPrepare) {
  const prepare = require(path.join(MODULES, e.name, 'index.js')).setup.prepare;
  const scenarios = [
    ['no saved settings', { settings: {}, saved: {} }],
    ['saved ports 9971 and 9972, no run_as', { settings: { control_port: 9971, agent_port: 9972 }, saved: { control_port: 9971, agent_port: 9972 } }],
  ];
  for (const [name, part] of scenarios) {
    test(`${e.name}: prepare asked twice with the same answers gives the same result and writes nothing (${name})`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-twice-'));
      const home = path.join(dir, 'home'), dataDir = path.join(dir, 'data');
      fs.mkdirSync(home); fs.mkdirSync(dataDir);
      const oldEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
      process.env.HOME = home; process.env.USERPROFILE = home;
      try {
        const calls = [];
        const portFree = async (port, host) => { calls.push([port, host]); return true; };
        const mk = () => ({ facts: FACTS(), settings: { ...part.settings }, saved: { ...part.saved }, choices: {}, platform: 'linux', portFree, dataDir, home });
        const before = snapshot(dir);
        const first = await prepare(mk());
        const callsFirst = calls.length;
        const second = await prepare(mk());
        assert.deepStrictEqual(second, first, 'the same answers give the same result');
        assert.strictEqual(calls.length, callsFirst * 2, 'the same look at the ports each time');
        assert.deepStrictEqual(snapshot(dir), before, 'no file was written');
      } finally {
        for (const [k, v] of Object.entries(oldEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
