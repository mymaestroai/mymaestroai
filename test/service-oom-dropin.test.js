'use strict';
// The hub's own unit gets a drop-in (ManagedOOMPreference=avoid): written by install and by update, idempotent, never on a Mac.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServiceManager } = require('../lib/service-manager');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oomdrop-'));
  const home = path.join(root, 'home'), dir = path.join(root, 'app');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  return { home, dir };
}
function recorder() { const calls = []; return { calls, exec: (cmd, args) => { calls.push([cmd, ...args].join(' ')); return ''; } }; }
const WANT = '[Service]\nManagedOOMPreference=avoid\n';

test('install writes the drop-in before daemon-reload, next to the unit', () => {
  const { home, dir } = sandbox();
  const r = recorder();
  let atReload = null;
  const exec = (cmd, args) => { if (args.join(' ') === '--user daemon-reload') atReload = fs.existsSync(path.join(home, '.config/systemd/user/mymaestroai.service.d/50-mymaestro-memory.conf')); return r.exec(cmd, args); };
  const m = createServiceManager({ dir, home, platform: 'linux', exec });
  assert.strictEqual(m.install({ node: '/n/bin/node' }).ok, true);
  const f = path.join(home, '.config/systemd/user/mymaestroai.service.d/50-mymaestro-memory.conf');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), WANT);
  assert.strictEqual(atReload, true, 'the drop-in was already on disk when daemon-reload ran');
});

test('writeOomDropIn is idempotent and leaves other drop-ins alone', () => {
  const { home, dir } = sandbox();
  const m = createServiceManager({ dir, home, platform: 'linux', exec: recorder().exec });
  const folder = path.join(home, '.config/systemd/user/x.service.d');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, '10-mine.conf'), '[Service]\nNice=5\n');
  assert.strictEqual(m.writeOomDropIn('x.service').changed, true);
  const f = path.join(folder, '50-mymaestro-memory.conf');
  const t1 = fs.statSync(f).mtimeMs;
  assert.strictEqual(m.writeOomDropIn('x.service').changed, false);
  assert.strictEqual(fs.statSync(f).mtimeMs, t1);
  assert.strictEqual(fs.readFileSync(path.join(folder, '10-mine.conf'), 'utf8'), '[Service]\nNice=5\n');
  fs.writeFileSync(f, 'old');   // a stale copy is put right
  assert.strictEqual(m.writeOomDropIn('x.service').changed, true);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), WANT);
});

test('update path: a hand-written unit found by detect() gets the drop-in and a daemon-reload, no restart', () => {
  const { home, dir } = sandbox();
  const unitDir = path.join(home, '.config/systemd/user');
  fs.mkdirSync(unitDir, { recursive: true });
  fs.writeFileSync(path.join(unitDir, 'agent-hub-v5.service'), `[Service]\nWorkingDirectory=${dir}\nExecStart=/usr/bin/node ${dir}/server.js\n`);
  const r = recorder();
  const m = createServiceManager({ dir, home, platform: 'linux', exec: r.exec });
  const res = m.ensureOomDropIn();
  assert.strictEqual(res.changed, true);
  assert.strictEqual(fs.readFileSync(path.join(unitDir, 'agent-hub-v5.service.d/50-mymaestro-memory.conf'), 'utf8'), WANT);
  assert.deepStrictEqual(r.calls, ['systemctl --user show agent-hub-v5.service -p ManagedOOMPreference --value', 'systemctl --user daemon-reload']);
});

test('update path: a reload that failed earlier is retried while systemd does not report avoid; once it does, no reload', () => {
  const { home, dir } = sandbox();
  const unitDir = path.join(home, '.config/systemd/user');
  fs.mkdirSync(unitDir, { recursive: true });
  fs.writeFileSync(path.join(unitDir, 'agent-hub-v5.service'), `[Service]\nWorkingDirectory=${dir}\nExecStart=/usr/bin/node ${dir}/server.js\n`);
  const calls = []; let shown = '';
  const exec = (cmd, args) => { calls.push(args.join(' ')); if (args[1] === 'show') return shown; return ''; };
  const m = createServiceManager({ dir, home, platform: 'linux', exec });
  m.ensureOomDropIn();                                   // writes + reloads
  calls.length = 0;
  const again = m.ensureOomDropIn();                     // file already there, but systemd still says nothing: reload anyway
  assert.strictEqual(again.changed, false);
  assert.ok(calls.includes('--user daemon-reload'), 'a failed earlier reload is retried');
  calls.length = 0; shown = 'avoid\n';
  m.ensureOomDropIn();
  assert.ok(!calls.includes('--user daemon-reload'), 'systemd reports avoid: nothing to reload');
});

test('update path: a failing write or reload gives a one-line warning and never throws', () => {
  const { home, dir } = sandbox();
  const unitDir = path.join(home, '.config/systemd/user');
  fs.mkdirSync(unitDir, { recursive: true });
  fs.writeFileSync(path.join(unitDir, 'agent-hub-v5.service'), `[Service]\nWorkingDirectory=${dir}\nExecStart=/usr/bin/node ${dir}/server.js\n`);
  const bad = (cmd, args) => { if (args.includes('daemon-reload')) { const e = new Error('boom'); e.stderr = 'Failed to reload'; throw e; } return ''; };
  const m = createServiceManager({ dir, home, platform: 'linux', exec: bad });
  const r = m.ensureOomDropIn();
  assert.strictEqual(r.ok, false);
  assert.match(r.warning, /^could not reload systemd/);
  assert.ok(!/\n/.test(r.warning));
  const { home: h2, dir: d2 } = sandbox();
  const u2 = path.join(h2, '.config/systemd/user'); fs.mkdirSync(u2, { recursive: true });
  fs.writeFileSync(path.join(u2, 'agent-hub-v5.service'), `[Service]\nWorkingDirectory=${d2}\nExecStart=/usr/bin/node ${d2}/server.js\n`);
  fs.writeFileSync(path.join(u2, 'agent-hub-v5.service.d'), 'blocker');
  const w = createServiceManager({ dir: d2, home: h2, platform: 'linux', exec: recorder().exec }).ensureOomDropIn();
  assert.strictEqual(w.ok, false);
  assert.match(w.warning, /^could not write the memory drop-in/);
});

test('scripts/hub-cli.js update calls ensureOomDropIn before the restart', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'hub-cli.js'), 'utf8');
  const i = src.indexOf('svc().ensureOomDropIn()');
  assert.ok(i > 0, 'update writes the drop-in');
  assert.match(src.slice(i, i + 300), /warning/, 'a failure prints one warning line');
  assert.ok(src.indexOf('await commands.restart()', i) > i && src.indexOf('await commands.restart()', i) - i < 300);
});

test('Mac and no-service: nothing is written', () => {
  const { home, dir } = sandbox();
  const r = recorder();
  const mac = createServiceManager({ dir, home, platform: 'darwin', exec: r.exec });
  assert.strictEqual(mac.writeOomDropIn('x.service').skipped, true);
  assert.strictEqual(mac.ensureOomDropIn().skipped, true);
  assert.strictEqual(fs.existsSync(path.join(home, '.config')), false);
  const none = createServiceManager({ dir, home, platform: 'linux', exec: r.exec });
  assert.strictEqual(none.ensureOomDropIn().skipped, true);   // no unit found
  assert.deepStrictEqual(r.calls, []);
});
