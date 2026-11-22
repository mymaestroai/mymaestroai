'use strict';
// Remote computers: the words "My Maestro's computer" (where My Maestro runs) and "the PC" (the machine to control) are never mixed up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'modules', 'remote-computers');
const moduleJson = JSON.parse(fs.readFileSync(path.join(DIR, 'module.json'), 'utf8'));
const setup = JSON.parse(fs.readFileSync(path.join(DIR, 'setup.json'), 'utf8'));
const guide = fs.readFileSync(path.join(DIR, 'guide.md'), 'utf8');
const meshserver = fs.readFileSync(path.join(DIR, 'lib', 'meshserver.js'), 'utf8');
const setting = (key) => moduleJson.settings.find((s) => s.key === key);
const step = (id) => setup.steps.find((s) => s.id === id);

test('the card text: plain words, no server name, asking happens on your phone', () => {
  assert.strictEqual(moduleJson.summary, 'Lets your agents see your other computers and, when you allow it, control them, over your private network (Tailscale). Each agent starts at Look: pictures and facts only. Act and Drive ask on your phone each session unless you turn asking off for that agent.');
  assert.ok(!/MeshCentral/i.test(moduleJson.summary));
});

test('the setting labels name the computer your Maestro runs on in plain words', () => {
  assert.strictEqual(setting('address_name').label, 'This computer\'s name on your private network');
  assert.strictEqual(setting('listen_ip').label, 'This computer\'s address on your private network');
  assert.strictEqual(setting('control_port').label, 'Port on this computer for the connector');
  assert.strictEqual(setting('agent_port').label, 'Port the other computers connect to');
  assert.strictEqual(setting('run_as').label, 'How the server runs');
});

test('no setting label, help or step body uses "tailnet", "systemd" or "MeshCentral" (the service option may name systemd)', () => {
  for (const s of moduleJson.settings) {
    for (const [what, text] of [['label', s.label], ['help', s.help]]) {
      assert.ok(!/tailnet|MeshCentral/i.test(text || ''), `${s.key} ${what}`);
      if (s.key !== 'run_as') assert.ok(!/systemd/i.test(text || ''), `${s.key} ${what}`);
    }
  }
  for (const st of setup.steps) {
    for (const text of [st.title, st.body, st.confirm]) assert.ok(!/tailnet|systemd|MeshCentral/i.test(text || ''), `step ${st.id}`);
  }
});

test('the setup says "the computer your Maestro runs on" and "the computer you want to control", never "PC"', () => {
  for (const st of setup.steps) assert.ok(!/\bPCs?\b/.test(`${st.title} ${st.body || ''}`), `step ${st.id}`);
  assert.ok(step('setup').body.includes('the computer your Maestro runs on'));
  assert.ok(step('add').body.includes('the computer you want to control'));
});

test('the install size is the same, and the measured 210 MB, in the setup step and in the guide', () => {
  const a = /about (\d+) MB once/i.exec(step('setup').body);
  const b = /about (\d+) MB in all/i.exec(guide);
  assert.ok(a && b, 'both say the total');
  assert.strictEqual(a[1], b[1]);
  assert.strictEqual(a[1], '210');
  assert.ok(!guide.includes('110 MB') && !guide.includes('230 MB'));
  assert.ok(!step('setup').body.includes('230 MB'));
});

test('the guide never says "this computer"', () => {
  assert.ok(!/this computer/i.test(guide));
});

test('the three service messages lead with Ask Maestro and then name My Maestro\'s computer for a terminal', () => {
  for (const name of ['NOT_INSTALLED_MESSAGE', 'NOT_RUNNING_MESSAGE', 'NEEDS_UPDATE_MESSAGE']) {
    const line = meshserver.split('\n').find((l) => l.includes(`const ${name} =`));
    assert.ok(line, name);
    assert.ok(line.indexOf('Press Ask Maestro and Maestro') !== -1, `${name} leads with Ask Maestro`);
    assert.ok(line.indexOf('(it needs administrator rights on My Maestro\'s computer)') > line.indexOf('Press Ask Maestro'), `${name} says what Ask Maestro needs`);
    assert.ok(line.indexOf('Press Ask Maestro') < line.indexOf(' yourself in a terminal on My Maestro\'s computer'), name);
    assert.ok(!/this computer/i.test(line), name);
  }
  assert.ok(meshserver.includes('`MeshCentral needs to be installed as its own service once. Press Ask Maestro and Maestro runs this for you (it needs administrator rights on My Maestro\'s computer). Or run it yourself in a terminal on My Maestro\'s computer'));
});
