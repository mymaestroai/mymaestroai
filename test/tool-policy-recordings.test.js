'use strict';
// Call recordings (<hub home>/call-recordings) are never an agent's: every file tool and shell command that names the folder is
// refused for every role, the lead and a member's agent included. (A tool call that does not name it is unaffected.)
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
// Every lib/ module is loaded from a throwaway copy of the install (test/helpers/isolated-install.js), so nothing it reads or
// writes under data/ (users.json, settings.json, push subscriptions ...) is the real install's.
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('tp-rec-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const tp = L('tool-policy');

const HUB = tp.HUB_ROOT;
const DIR = path.join(tp.HUB_HOME, 'call-recordings');
const worker = { name: 'helper', category: 'worker' };
const head = { name: 'biographer', category: 'primary' };
const lead = { name: 'maestro', category: 'primary', lead: true };
const member = { name: 'sam_assistant', category: 'primary', owner: 'u_sam' };
const cwd = (a) => path.join(HUB, 'workspaces', a.name);
const roles = [['worker', worker, {}], ['head', head, {}], ['lead', lead, {}], ['member agent', member, { isMemberOwned: () => true }]];
const sessionFile = path.join(DIR, 'biographer', '20261113-220000-0a0b0c', '0001-person.flac.enc');

test('the recordings folder is where call recordings live, under the hub home', () => {
  assert.strictEqual(tp.RECORDINGS_DIR, DIR);
  assert.ok(path.isAbsolute(DIR));
});

test('a Read, Glob, Grep, Write or Edit naming the folder or a file in it is denied for every role', () => {
  for (const [label, agent, extra] of roles) {
    for (const [tool, input] of [
      ['Read', { file_path: sessionFile }],
      ['Read', { file_path: path.join(DIR, 'biographer', '20261113-220000-0a0b0c', 'manifest.json.enc') }],
      ['mcp__hub__Read', { file_path: sessionFile }],
      ['Glob', { pattern: '**/*.enc', path: DIR }],
      ['Glob', { pattern: path.join(DIR, '**', '*') }],
      ['Grep', { pattern: 'x', path: DIR }],
      ['Write', { file_path: path.join(DIR, 'planted.txt'), content: 'x' }],
      ['Edit', { file_path: sessionFile, old_string: 'a', new_string: 'b' }],
      ['Read', { file_path: path.relative(cwd(agent), sessionFile) }],   // a relative spelling of the same place
      ['Read', { file_path: path.join(DIR, '..', 'call-recordings', 'x') }],
    ]) {
      const d = tp.decide({ agent, tool, input, cwd: cwd(agent), ...extra });
      assert.strictEqual(d.decision, 'deny', `${label}: ${tool} ${JSON.stringify(input)}`);
      assert.strictEqual(d.cls, 'admin');
      assert.match(d.reason, /call recordings are not available to agents/);
    }
  }
});

test('a Bash command naming the folder is denied for every role, however it reads or lists', () => {
  for (const [label, agent, extra] of roles) {
    for (const command of [
      `cat ${sessionFile}`,
      `ls -la ${DIR}`,
      `ls ${DIR}/biographer`,
      `cp ${sessionFile} /tmp/x.enc`,
      `tar -czf /tmp/all.tgz -C ${tp.HUB_HOME} call-recordings`,
      `cd ${tp.HUB_HOME} && ls call-recordings`,
      `find ${tp.HUB_HOME} -path '*call-recordings*' -name '*.enc'`,
      `cat "${sessionFile}" | base64`,
      `python3 -c "print(open('${sessionFile}','rb').read()[:8])"`,
      `rm -f ${sessionFile}`,
    ]) {
      const d = tp.decide({ agent, tool: 'Bash', input: { command }, cwd: cwd(agent), ...extra });
      assert.strictEqual(d.decision, 'deny', `${label}: ${command}`);
      const m = tp.decide({ agent, tool: 'mcp__hub__Bash', input: { command }, cwd: cwd(agent), ...extra });
      assert.strictEqual(m.decision, 'deny', `${label}: mcp__hub__Bash ${command}`);
      const j = tp.decide({ agent, tool: 'run_job', input: { command, name: 'x' }, cwd: cwd(agent), ...extra });
      assert.strictEqual(j.decision, 'deny', `${label}: run_job ${command}`);
    }
  }
});

test('an approval never opens it: an "approve for an hour" allowance does not apply', () => {
  const allowances = tp.createAllowances();
  const input = { file_path: sessionFile };
  const first = tp.decide({ agent: lead, tool: 'Read', input, cwd: cwd(lead), allowances });
  assert.strictEqual(first.decision, 'deny');
  const fake = { has: () => true };
  assert.strictEqual(tp.decide({ agent: lead, tool: 'Read', input, cwd: cwd(lead), allowances: fake }).decision, 'deny');
});

test('the classifiers also call it an admin place (read and write), like data/.auth-key', () => {
  assert.strictEqual(tp.classifyReadPath(sessionFile, { roots: [DIR] }), 'admin');
  assert.strictEqual(tp.classifyPath(sessionFile, { roots: [DIR] }), 'admin');
  assert.ok(tp.isSensitiveRead(sessionFile));
  assert.ok(tp.isSensitiveRead(path.join(HUB, 'data', '.auth-key')));
});

test('other reads and commands are untouched', () => {
  for (const [label, agent, extra] of roles) {
    const ws = path.join(cwd(agent), 'notes.txt');
    assert.strictEqual(tp.decide({ agent, tool: 'Read', input: { file_path: ws }, cwd: cwd(agent), ...extra }).decision, 'allow', label);
    assert.strictEqual(tp.decide({ agent, tool: 'Bash', input: { command: `cat ${ws}` }, cwd: cwd(agent), ...extra }).decision, 'allow', label);
  }
  assert.strictEqual(tp.touchesRecordings({ input: { file_path: path.join(tp.HUB_HOME, 'call-recordings-notes.txt') }, cwd: cwd(worker), agentName: 'helper' }), false, 'a sibling name is not the folder');
});
