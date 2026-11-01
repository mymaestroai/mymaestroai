'use strict';
// `mymaestro connect chatgpt` (scripts/hub-cli.js): a stand-in `codex` where the hub looks for it, run through the real
// command. Codex already there skips the install; the sign-in uses the browser on a desktop and a code without one.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'scripts', 'hub-cli.js');

// signedIn: the stand-in's starting state; login: 'ok' signs it in, anything else leaves it signed out.
function install({ signedIn = false, login = 'ok', status = 'Logged in using ChatGPT' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-'));
  const bin = path.join(home, '.npm-global', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  if (signedIn) fs.writeFileSync(path.join(home, 'in'), '');
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh
if [ "$1 $2" = "login status" ]; then
  if [ -f "${home}/in" ]; then echo "${status}"; else echo "Not logged in"; exit 1; fi
  exit 0
fi
echo "$@" >> "${home}/calls"
${login === 'ok' ? `touch "${home}/in"` : 'exit 1'}
`, { mode: 0o755 });
  return home;
}
function run(home, args, extra = {}) {
  const env = { PATH: process.env.PATH, HOME: home, ...extra };
  return spawnSync(process.execPath, [CLI, 'connect', ...args], { env, encoding: 'utf8', timeout: 20000 });
}
const calls = (home) => { try { return fs.readFileSync(path.join(home, 'calls'), 'utf8').trim(); } catch { return ''; } };

test('only `connect chatgpt` is a command', () => {
  const r = run(install(), ['claude']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /Usage: mymaestro connect chatgpt/);
});

test('already signed in: nothing to install or sign in, and it says where to go next', () => {
  const home = install({ signedIn: true });
  const r = run(home, ['chatgpt']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /already signed in to ChatGPT/);
  assert.match(r.stdout, /press Check on the setup page, or in Settings under AI models/);
  assert.strictEqual(calls(home), '');
});

test('on a desktop the sign-in opens the browser', () => {
  const home = install();
  const r = run(home, ['chatgpt'], { DISPLAY: ':0' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(calls(home), 'login');
  assert.doesNotMatch(r.stdout, /Installing Codex/);
  assert.match(r.stdout, /opens ChatGPT in your browser/);
});

test('with no desktop, over SSH, or when asked, it signs in with a code and says what to do if that is switched off', () => {
  for (const [args, env] of [[['chatgpt'], {}], [['chatgpt'], { DISPLAY: ':0', SSH_CONNECTION: '1 2 3 4' }], [['chatgpt', '--device-auth'], { DISPLAY: ':0' }]]) {
    const home = install();
    const r = run(home, args, env);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(calls(home), 'login --device-auth', JSON.stringify(env));
    assert.match(r.stdout, /a link and a code/);
    assert.match(r.stdout, /turn on device code sign-in under Security in your ChatGPT settings/);
  }
});

test('a sign-in that did not finish fails plainly; an API-key sign-in is replaced by ChatGPT', () => {
  const home = install({ login: 'no' });
  const r = run(home, ['chatgpt'], { DISPLAY: ':0' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /did not finish/);

  const keyed = install({ signedIn: true, status: 'Logged in using an API key' });
  const k = run(keyed, ['chatgpt'], { DISPLAY: ':0' });
  assert.strictEqual(calls(keyed), 'login', 'it does sign in');
  assert.strictEqual(k.status, 1, 'the stand-in stays on its API key, so the command does not claim success');
});

test('the help text lists it, and the install goes where the hub looks for Codex', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  assert.match(src, /mymaestro connect chatgpt {8}use your ChatGPT subscription/);
  assert.match(src, /'install', '-g', '--prefix', path\.join\(os\.homedir\(\), '\.npm-global'\), '@openai\/codex', '--ignore-scripts'/);
  assert.match(spawnSync(process.execPath, [CLI, 'help'], { encoding: 'utf8' }).stdout, /mymaestro connect chatgpt/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'lib', 'codex-cli', 'index.js'), 'utf8'), /path\.join\(home, '\.npm-global', 'bin', 'codex'\)/);
});
