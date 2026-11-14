'use strict';
// Call recordings (<hub home>/call-recordings) are never an agent's: every file tool and shell command that names the folder is
// refused for every role, the lead and a member's agent included. (A tool call that does not name it is unaffected.)
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const tp = require('../lib/tool-policy');

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
      `find ${DIR} -name '*.enc'`,
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

const T = (input, agent = worker) => tp.touchesRecordings({ input, cwd: cwd(agent), agentName: agent.name });
const sh = (command) => T({ command });

test('the folder name in command text is not an access (commit messages, grep words, sibling file names)', () => {
  assert.strictEqual(sh('git commit -m "fix call-recordings docs"'), false);
  assert.strictEqual(sh('git commit -m "call-recordings docs"'), false);
  assert.strictEqual(sh('grep -rn call-recordings /some/repo/lib'), false);
  assert.strictEqual(sh('cat ./call-recordings-notes.md'), false);
  assert.strictEqual(sh(`ls ${tp.HUB_HOME}`), false);
  assert.strictEqual(sh('echo call-recordings'), false);
  assert.strictEqual(T({ file_path: path.join(tp.HUB_HOME, 'call-recordings-notes.txt') }), false);
  const d = tp.decide({ agent: worker, tool: 'Bash', input: { command: 'git commit -m "fix call-recordings docs"' }, cwd: cwd(worker) });
  assert.doesNotMatch(d.reason || '', /call recordings are not available/);
});

test('real access is refused: absolute, ~, $HOME, relative, and after cd / pushd / tar -C', () => {
  const home = tp.HUB_HOME;
  assert.ok(sh(`ls ${DIR}`));
  assert.ok(sh(`find ${DIR} -name x`));
  assert.ok(sh(`tar cf x.tar ${DIR}`));
  assert.ok(sh(`cd ${home}; ls call-recordings`));
  assert.ok(sh(`cd ${home} && cat call-recordings/x`));
  assert.ok(sh(`pushd ${home} >/dev/null && ls call-recordings/biographer`));
  assert.ok(sh(`cd "${home}" && ls ./call-recordings`));
  assert.ok(sh(`tar -czf /tmp/a.tgz -C ${home} call-recordings`));
  assert.ok(tp.touchesRecordings({ input: { command: 'cat call-recordings/x' }, cwd: home }));
  assert.ok(tp.touchesRecordings({ input: { command: 'cat ../call-recordings/x' }, cwd: path.join(DIR, 'a') }));
  const rel = DIR.startsWith(require('os').homedir() + '/') ? DIR.slice(require('os').homedir().length + 1) : null;
  if (rel) {
    assert.ok(sh(`cat ~/${rel}/x`));
    assert.ok(sh(`cat $HOME/${rel}/x`));
    assert.ok(sh(`cat \${HOME}/${rel}/x`));
    assert.ok(sh(`cd ~/${path.dirname(rel)} && cat ${path.basename(rel)}/x`));
  }
});

test('globs that could match the folder or anything under it are refused', () => {
  const home = tp.HUB_HOME;
  assert.ok(sh(`cat ${home}/call-rec*/*/*`));
  assert.ok(sh(`cat ${home}/call-recording?/x`));
  assert.ok(sh(`cat ${home}/call-[r]ecordings/x`));
  assert.ok(sh(`cat ${home}/{a,call-recordings}/x`));
  assert.ok(sh(`ls ${home}/**/x.enc`));
  assert.ok(sh(`cd ${home} && cat call-rec*/*/*`));
  assert.ok(T({ path: home, pattern: '**/*.flac.enc' }));
  assert.ok(T({ path: home, pattern: 'call-recordings/**' }));
  assert.ok(T({ pattern: `${home}/**/*.enc` }));
  assert.ok(T({ file_path: DIR + '/a/b.enc' }));
  for (const [, agent, extra] of roles) {
    const d = tp.decide({ agent, tool: 'Glob', input: { path: home, pattern: '**/*.flac.enc' }, cwd: cwd(agent), ...extra });
    assert.strictEqual(d.decision, 'deny');
    assert.match(d.reason, /call recordings are not available to agents/);
  }
  // globs elsewhere, or only on a parent, are not refused
  assert.strictEqual(sh('ls /some/repo/lib/*.js'), false);
  assert.strictEqual(sh(`cat ${home}/other*/x`), false);
  assert.strictEqual(sh(`ls ${path.dirname(home)}/*`), false);
  assert.strictEqual(T({ path: '/some/repo', pattern: '**/*.js' }), false);
});

test('other reads and commands are untouched', () => {
  for (const [label, agent, extra] of roles) {
    const ws = path.join(cwd(agent), 'notes.txt');
    assert.strictEqual(tp.decide({ agent, tool: 'Read', input: { file_path: ws }, cwd: cwd(agent), ...extra }).decision, 'allow', label);
    assert.strictEqual(tp.decide({ agent, tool: 'Bash', input: { command: `cat ${ws}` }, cwd: cwd(agent), ...extra }).decision, 'allow', label);
  }
  assert.strictEqual(tp.touchesRecordings({ input: { file_path: path.join(tp.HUB_HOME, 'call-recordings-notes.txt') }, cwd: cwd(worker), agentName: 'helper' }), false, 'a sibling name is not the folder');
});
