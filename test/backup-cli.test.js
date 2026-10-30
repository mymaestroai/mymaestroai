'use strict';
// `mymaestro restore` (scripts/hub-cli.js) on a throwaway install with its own copy of the program: refused while the
// hub answers; a wrong password changes nothing; the right one shows what changes and waits for RESTORE; any other
// answer forgets the checked copy; RESTORE writes the journal, and the next start puts the backup in place.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const keys = require('../lib/backup/keys');
const places = require('../lib/backup/places');
const { createBackup } = require('../lib/backup/create');
const apply = require('../lib/backup/apply');
const { makeInstall, memSettings } = require('./helpers/backup-fixture');

const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-cli-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const PW = 'cli test passphrase';

const freePort = () => new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
// Run the install's own CLI with HOME pointing at the throwaway home; answer each prompt when it appears.
function cli(inst, args, answers = []) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(inst.root, 'scripts', 'hub-cli.js'), ...args], { cwd: inst.root, env: { PATH: process.env.PATH, HOME: inst.home } });
    let out = '', errOut = '', next = 0, seen = 0;
    p.stdout.on('data', (d) => {
      out += d;
      while (next < answers.length && out.indexOf(answers[next][0], seen) >= 0) { seen = out.indexOf(answers[next][0], seen) + answers[next][0].length; p.stdin.write(answers[next][1] + '\n'); next++; }
    });
    p.stderr.on('data', (d) => { errOut += d; });
    const t = setTimeout(() => p.kill(), 60000);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err: errOut }); });
  });
}

test('mymaestro restore: refused while running, a wrong password changes nothing, RESTORE or nothing, then the swap at the next start', async () => {
  const inst = makeInstall(TMP, 'cli', { layout: 'inside' });
  for (const d of ['lib', 'scripts']) fs.cpSync(path.join(REPO, d), path.join(inst.root, d), { recursive: true });
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(inst.root, 'node_modules'));
  const port = await freePort();
  fs.writeFileSync(path.join(inst.root, '.env'), `PORT=${port}\n`);
  const settings = memSettings();
  await keys.setup(PW, { settings, logN: 15 });
  const made = await createBackup({ ...inst, platform: 'linux', settings, places: [places.localPlace(inst.hubHome)], hub: { version: '5.8.1', channel: 'experimental' } });
  const file = made.places[0].file;
  // Work done after the backup
  const D = (...p) => path.join(inst.root, 'data', ...p);
  fs.writeFileSync(D('agents.json'), JSON.stringify([{ name: 'doc' }, { name: 'a' }, { name: 'open' }, { name: 'homerepair' }]));
  fs.appendFileSync(D('conversations', 'doc.jsonl'), '{"role":"user","content":"after"}\n');
  const R = (...p) => path.join(inst.root, '.restore', ...p);

  // While the hub answers on its port: refused before anything is asked
  const busy = http.createServer((q, s) => s.end('ok')).listen(port, '127.0.0.1');
  await new Promise(r => busy.once('listening', r));
  const r1 = await cli(inst, ['restore', file, '--yes', '--no-start']);
  busy.close();
  assert.strictEqual(r1.code, 1);
  assert.match(r1.err, /Stop My Maestro first/);

  const r2 = await cli(inst, ['restore', file, '--no-start'], [['Backup password: ', 'not the password']]);
  assert.strictEqual(r2.code, 1, r2.out + r2.err);
  assert.match(r2.err, /password/i);
  assert.ok(!fs.existsSync(R('new')) && !fs.existsSync(R('prepared.json')) && !fs.existsSync(R('journal.json')), 'a refusal leaves nothing');

  const r3 = await cli(inst, ['restore', file, '--no-start'], [['Backup password: ', PW], ['Type RESTORE', 'restore']]);
  assert.strictEqual(r3.code, 1, r3.out + r3.err);
  assert.match(r3.out, /The backup is good\. Restoring it replaces this install:/);
  assert.match(r3.out, /Agents created since then go away: homerepair\./);
  assert.match(r3.out, /1 chat messages written since then are lost \(doc\)\./);
  assert.match(r3.out, /mymaestro restore --undo puts it back/);
  assert.match(r3.err, /Nothing was changed\./);
  assert.ok(!fs.existsSync(R('new')) && !fs.existsSync(R('prepared.json')) && !fs.existsSync(R('journal.json')), 'not RESTORE: the checked copy is forgotten');

  const r4 = await cli(inst, ['restore', file, '--no-start'], [['Backup password: ', PW], ['Type RESTORE', 'RESTORE']]);
  assert.strictEqual(r4.code, 0, r4.out + r4.err);
  assert.match(r4.out, /Confirmed: the backup replaces this install when My Maestro starts\./);
  assert.ok(fs.existsSync(R('journal.json')));
  assert.ok(JSON.parse(fs.readFileSync(D('agents.json'), 'utf8')).some(a => a.name === 'homerepair'), 'nothing moves before the start');

  // The next start carries it out
  const done = apply.applyAtBoot({ root: inst.root, log: () => {} });
  assert.strictEqual(done.state, 'applied', JSON.stringify(done).slice(0, 300));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(D('agents.json'), 'utf8')).map(a => a.name), ['doc', 'a', 'open']);
  assert.strictEqual(fs.readFileSync(path.join(inst.root, '.env'), 'utf8'), `PORT=${port}\n`, 'the port of this install is kept');
  assert.strictEqual(fs.readFileSync(path.join(inst.home, '.codex', 'auth.json'), 'utf8'), '{"tokens":{}}', 'sign-ins go to this install\'s home');

  const r5 = await cli(inst, ['restore', '--undo', '--yes', '--no-start']);
  assert.strictEqual(r5.code, 1, 'no undo before the restored setup has run healthily');
  assert.match(r5.err, /There is no restore to undo here/);
});
