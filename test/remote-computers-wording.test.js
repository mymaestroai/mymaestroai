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

test('the tailnet name and address settings say they are about My Maestro\'s computer, not the PC', () => {
  for (const key of ['address_name', 'listen_ip']) {
    const s = setting(key);
    assert.ok(s.label.startsWith('My Maestro\'s computer'), `${key} label: ${s.label}`);
    assert.ok(s.help.includes('NOT the PC you want to control'), `${key} help`);
  }
});

test('no setting label or help, and no body of the prefs, server, pc and install steps, says "this computer"', () => {
  for (const s of moduleJson.settings) {
    assert.ok(!/this computer/i.test(s.label || ''), `${s.key} label`);
    assert.ok(!/this computer/i.test(s.help || ''), `${s.key} help`);
  }
  for (const id of ['prefs', 'server', 'pc', 'install']) assert.ok(!/this computer/i.test(step(id).body), `step ${id}`);
});

test('the server step tells the owner to press Ask Maestro; the pc step says not to sign in to My Maestro on the PC', () => {
  assert.ok(step('server').body.includes('Ask Maestro'));
  assert.ok(step('pc').body.includes('Don\'t sign in to My Maestro on that PC'));
  assert.ok(step('pc').body.includes('the same tailnet as My Maestro\'s computer'));
});

test('the install size is the same, and the measured 210 MB, in the setup step and in the guide', () => {
  const re = /about (\d+) MB in all/i;
  const a = re.exec(step('install').body);
  const b = re.exec(guide);
  assert.ok(a && b, 'both say the total');
  assert.strictEqual(a[1], b[1]);
  assert.strictEqual(a[1], '210');
  assert.ok(!guide.includes('110 MB') && !guide.includes('230 MB'));
  assert.ok(!step('install').body.includes('230 MB'));
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
