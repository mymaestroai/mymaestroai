'use strict';
// The policy check judges a path written with `..` where the file system really takes it (lib/tool-policy kernelPath:
// links followed one component at a time, then `..`), as well as the path as typed, and keeps the stricter answer.
// A link loop or an unreadable step is judged as outside; a missing folder on the way leaves the typed answer.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const tp = require('../lib/tool-policy');

const X = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-kp-x-'));    // the agent's granted folder
const O = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-kp-o-'));    // somewhere outside it
fs.mkdirSync(path.join(O, 'sub'));
fs.mkdirSync(path.join(X, 'a'));
fs.symlinkSync('/usr/bin', path.join(X, 'link'));                  // X/link/.. is /usr to the file system, X to a folded path
fs.symlinkSync(path.join(O, 'sub'), path.join(X, 'olink'));        // O is under /tmp: inside a worker's default folders
fs.symlinkSync('loop2', path.join(X, 'loop1'));
fs.symlinkSync('loop1', path.join(X, 'loop2'));
const worker = { name: 'torque', category: 'worker', policy: { roots: [X] } };
const dec = (tool, input) => tp.decide({ agent: worker, tool, input, cwd: '/tmp' });

test('a write through link/.. is judged where it lands (/usr: admin, nothing is written), refused for a worker', () => {
  assert.equal(dec('Bash', { command: `cp /dev/null ${X}/link/../out.txt` }).cls, 'admin');
  assert.equal(dec('Bash', { command: `cp /dev/null ${X}/link/../out.txt` }).decision, 'deny');
  // the file tools fold `..` themselves before they write (lib/hub-tools path.resolve), so the folded path is what they touch
  assert.equal(dec('Write', { file_path: `${X}/link/../out.txt` }).cls, 'write_inside', 'the Write tool writes the folded X/out.txt');
  assert.equal(dec('Bash', { command: `cd ${X}/link && cp /dev/null ../out.txt` }).cls, 'admin', 'a relative .. after cd into the link');
  assert.equal(dec('Read', { file_path: `${X}/link/../notes.txt` }).cls, 'read', 'the Read tool reads the folded X/notes.txt');
});

test('a loop or an unreadable step is judged as outside; a missing folder keeps the typed answer', () => {
  assert.equal(dec('Bash', { command: `cp /dev/null ${X}/loop1/../out.txt` }).cls, 'write_outside');
  assert.equal(dec('Bash', { command: `cp /dev/null ${X}/nothere/../out.txt` }).cls, 'write_inside');
  assert.equal(dec('Bash', { command: `cat ${X}/loop1/../notes.txt` }).cls, 'read_outside');
});

test('plain paths, and .. through plain folders, are judged as before', () => {
  assert.equal(dec('Bash', { command: `cp /dev/null ${X}/a/out.txt` }).cls, 'write_inside');
  assert.equal(dec('Bash', { command: `cp /dev/null ${X}/a/../out.txt` }).cls, 'write_inside');
  assert.equal(dec('Read', { file_path: `${X}/a/../notes.txt` }).cls, 'read');
  assert.equal(dec('Bash', { command: `cat /usr/bin/notes.txt` }).cls, 'read_outside');
});

test('a key read through link/.. stays admin; a read through link/.. into a secret place is admin', () => {
  fs.writeFileSync(path.join(O, 'id_ed25519'), 'k');
  assert.equal(dec('Bash', { command: `cat ${X}/olink/../id_ed25519` }).cls, 'admin');
  assert.equal(dec('Read', { file_path: `${X}/olink/../id_ed25519` }).cls, 'admin');
  // A secret place (~/.ssh) reached through a link: run the policy with a home of its own, so no real secret is touched.
  const H = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-kp-home-'));
  fs.mkdirSync(path.join(H, '.ssh', 'sub'), { recursive: true });
  const XH = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-kp-xh-'));
  fs.symlinkSync(path.join(H, '.ssh', 'sub'), path.join(XH, 'link'));
  const probe = `const tp = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'tool-policy'))});
    const a = { name: 'torque', category: 'worker', policy: { roots: [${JSON.stringify(XH)}] } };
    const c = (command) => tp.decide({ agent: a, tool: 'Bash', input: { command }, cwd: '/tmp' }).cls;
    process.stdout.write(JSON.stringify([c('cat ${XH}/link/../config'), c('cat ${XH}/config'), c('cat ${XH}/plain/../config ${XH}/link/../config')]));`;
  fs.mkdirSync(path.join(XH, 'elsewhere', 'sub'), { recursive: true });
  fs.symlinkSync(path.join(XH, 'elsewhere', 'sub'), path.join(XH, 'plain'));
  const out = JSON.parse(execFileSync(process.execPath, ['-e', probe], { env: { ...process.env, HOME: H }, encoding: 'utf8' }));
  assert.deepEqual(out.slice(0, 2), ['admin', 'read'], 'through the link it is ~/.ssh/config; the typed X/config is the agent\'s own');
  assert.equal(out[2], 'admin', 'review: two words fold to one path; the one that reaches ~/.ssh still counts');
});

test('a settings file reached through link/.. is refused like the file itself', () => {
  const A = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-kp-accounts-'));
  fs.mkdirSync(path.join(A, 'sub'));
  fs.writeFileSync(path.join(A, 'users.json'), '[]');
  const XS = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-kp-xs-'));
  fs.symlinkSync(path.join(A, 'sub'), path.join(XS, 'link'));
  const had = process.env.HUB_AUTH_DIR;
  try {
    process.env.HUB_AUTH_DIR = A;
    assert.equal(tp.touchesSettingsFile({ tool: 'Bash', input: { command: `echo x > ${XS}/link/../users.json` }, cwd: '/tmp' }), 'users.json');
    assert.equal(tp.touchesSettingsFile({ tool: 'Write', input: { file_path: `${XS}/link/../users.json` }, cwd: '/tmp' }), null, 'the Write tool writes the folded XS/users.json');
    assert.equal(tp.touchesSettingsFile({ tool: 'Bash', input: { command: `echo x > ${XS}/users.json` }, cwd: '/tmp' }), null, 'the typed path alone is not one');
    fs.mkdirSync(path.join(XS, 'other', 'sub'), { recursive: true });
    fs.symlinkSync(path.join(XS, 'other', 'sub'), path.join(XS, 'plain'));
    assert.equal(tp.touchesSettingsFile({ tool: 'Bash', input: { command: `echo x > ${XS}/plain/../users.json > ${XS}/link/../users.json` }, cwd: '/tmp' }), 'users.json', 'review: two words, one folded path, one of them a settings file');
  } finally { if (had === undefined) delete process.env.HUB_AUTH_DIR; else process.env.HUB_AUTH_DIR = had; }
});

test('the file tools are judged where they write: the folded path (they fold `..` themselves)', () => {
  const policy = tp.policyFor(worker);
  const w = tp.classifyTool({ tool: 'Write', input: { file_path: `${X}/link/../out.txt` }, agentName: 'torque', policy, cwd: '/tmp' });
  assert.deepEqual([w.cls, w.summary, w.detail], ['write_inside', path.join(X, 'out.txt'), { path: path.join(X, 'out.txt') }]);
  const hubTools = require('fs').readFileSync(path.join(__dirname, '..', 'lib', 'hub-tools.js'), 'utf8');
  assert.match(hubTools, /return path\.resolve\(cwd, s\);/, 'lib/hub-tools still folds paths before it touches a file; if that changes, judge file tools by kernelPath too');
});
