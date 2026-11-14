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

// ── review follow-ups: bypasses that must be refused ──────────────────────────────────────────
test('braces are expanded on the raw token before it is resolved', () => {
  const home = tp.HUB_HOME;
  assert.ok(sh(`cat {${sessionFile},/dev/null}`));
  assert.ok(sh(`cat {/dev/null,${home}/call-recordings/s/x.enc}`));
  assert.ok(sh(`cat {a,${home}}/call-recordings/a`));
  assert.ok(sh(`cat ${home}/call-{recordings,x}/a`));
  assert.ok(sh(`cat "{${DIR}/a,/dev/null}"`));
  const rel = path.relative(require('os').homedir(), path.dirname(DIR));
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    assert.ok(sh(`cat {$HOME,/x}/${rel}/call-recordings/a`));
    assert.ok(sh(`cat {\${HOME},/x}/${rel}/call-recordings/a`));
  }
  assert.strictEqual(sh('cat {a,b}/c'), false);
});

test('brace caps fail closed: more than 64 alternatives or more than 6 levels is refused', () => {
  const decoys = Array.from({ length: 70 }, (_, i) => `d${i}`).join(',');
  assert.ok(sh(`cat {${decoys},call-recordings}/a`));
  assert.ok(sh(`cat ${tp.HUB_HOME}/{${decoys},call-recordings}/a`));
  assert.ok(sh('cat {a,{b,{c,{d,{e,{f,{g,h}}}}}}}/x'));
  assert.ok(T({ file_path: `{${decoys},z}/x` }));
  assert.strictEqual(sh('cat {a,{b,{c,d}}}/x'), false);
});

test('POSIX classes and unparseable brackets in a glob segment match anything', () => {
  const home = tp.HUB_HOME;
  assert.ok(sh(`ls ${home}/call-[[:lower:]]ecordings`));
  assert.ok(sh(`ls ${home}/call-[[:alpha:]]ecordings/*`));
  assert.ok(sh(`ls ${home}/call-[[=r=]]ecordings`));
  assert.ok(sh(`ls ${home}/call-[recordings`));
  assert.ok(T({ pattern: `${home}/call-[[:lower:]]ecordings/**` }));
});

test('cd / pushd: option words are skipped and a quoted target followed by more text is one word', () => {
  const home = tp.HUB_HOME;
  assert.ok(sh(`cd -- ${home} && ls call-recordings`));
  assert.ok(sh(`cd -L ${home} && cat call-recordings/x`));
  assert.ok(sh(`cd -P -e ${home}; cat call-recordings/x`));
  assert.ok(sh(`cd -@ ${home}; cat call-recordings/x`));
  assert.ok(sh(`pushd -- ${home} >/dev/null; ls call-recordings`));
  assert.ok(sh(`cd "${path.dirname(home)}"/${path.basename(home)} && ls call-recordings`));
  assert.ok(sh(`cd '${path.dirname(home)}'/${path.basename(home)} && ls call-recordings`));
  assert.ok(sh(`cd ${path.dirname(home)}/"${path.basename(home)}" && ls call-recordings`));
  assert.ok(sh(`tar -czf /tmp/a.tgz --directory ${home} call-recordings`));
  assert.ok(sh(`tar -czf /tmp/a.tgz --directory=${home} call-recordings`));
  const rel = path.relative(require('os').homedir(), home);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) assert.ok(sh(`cd "$HOME"/${rel} && ls call-recordings`));
});

test('an unresolvable cd target makes the bare folder name a tripwire', () => {
  assert.ok(sh('cd "$SOME_DIR" && ls call-recordings'));
  assert.ok(sh('cd $(pwd)/.. && cat call-recordings'));
  assert.ok(sh('cd `dirname /x` && cat call-recordings'));
  assert.ok(sh('cd "$HOME"/$X && ls call-recordings'));
  assert.ok(sh('cd - && ls call-recordings'));
  assert.strictEqual(sh('cd /some/repo && ls call-recordings'), false);
  assert.strictEqual(sh('cd "$SOME_DIR" && ls lib'), false);
});

test('word tripwire: the folder name as a path segment, however quoted, is refused (aliases, symlinks, variables)', () => {
  assert.ok(sh('ls $X/call-recordings'));
  assert.ok(sh("cat $X/call-rec''ordings/a"));
  assert.ok(sh('cat $X/c\\all-recordings/a'));
  assert.ok(sh('cat "$X"/"call-recordings"/a'));
  assert.ok(sh('cat $X/CALL-Recordings/a'));
  assert.ok(sh('cat $X/{a,call-recordings}/a'));
  assert.ok(sh('cat --file=$X/call-recordings/a'));
  assert.ok(sh('ln -s /x/call-recordings ./y'));
  // plain words and sibling names stay allowed
  assert.strictEqual(sh('git commit -m "fix call-recordings docs"'), false);
  assert.strictEqual(sh('grep -rn call-recordings /some/repo/lib'), false);
  assert.strictEqual(sh('echo call-recordings'), false);
  assert.strictEqual(sh('cat ./call-recordings-notes.md'), false);
  assert.strictEqual(sh('cat $X/call-recordings-notes.md'), false);
  assert.strictEqual(sh('ls /some/repo/*'), false);
  assert.strictEqual(sh('ls /usr/lib/c*'), false);
});

test('real path: the folder and its parent are also compared by real path', () => {
  const fs = require('fs');
  const realParent = fs.existsSync(path.dirname(DIR)) ? fs.realpathSync(path.dirname(DIR)) : path.dirname(DIR);
  assert.ok(sh(`cat ${path.join(realParent, 'call-recordings')}/x`));
  assert.strictEqual(sh(`cat ${realParent}/not-it/x`), false);
});

test('bounds: more than 16 bases or 2000 tokens is refused; -C counts only for tar', () => {
  const cds = Array.from({ length: 20 }, (_, i) => `cd /tmp/d${i}`).join('; ');
  assert.ok(sh(`${cds}; ls`));
  assert.ok(sh(Array.from({ length: 2100 }, (_, i) => `w${i}`).join(' ')));
  assert.strictEqual(sh('grep -C 3 foo /some/repo/lib/x.js'), false);
  assert.strictEqual(sh('cd /tmp/a; cd /tmp/b; ls'), false);
  assert.strictEqual(sh('tar -xf a.tgz -C /tmp/out'), false);
  const many = Array.from({ length: 20 }, (_, i) => `grep -C ${i} x /y`).join('; ');
  assert.strictEqual(sh(many), false);
});

test('the Grep tool: its pattern is a regex, its path still counts', () => {
  const home = tp.HUB_HOME;
  for (const tool of ['Grep', 'mcp__hub__Grep']) {
    assert.strictEqual(tp.touchesRecordings({ tool, input: { pattern: `${home}/**/call-recordings/(a|b)`, path: '/some/repo' }, cwd: cwd(worker) }), false, tool);
    assert.strictEqual(tp.touchesRecordings({ tool, input: { pattern: '**/*.enc', path: home }, cwd: cwd(worker) }), false, tool);
    assert.strictEqual(tp.touchesRecordings({ tool, input: { pattern: 'x', path: DIR }, cwd: cwd(worker) }), true, tool);
    assert.strictEqual(tp.touchesRecordings({ tool, input: { pattern: 'x', path: home, glob: '**/*.enc' }, cwd: cwd(worker) }), true, tool);
  }
  assert.ok(tp.touchesRecordings({ tool: 'Glob', input: { pattern: '**/*.enc', path: tp.HUB_HOME }, cwd: cwd(worker) }));
});
