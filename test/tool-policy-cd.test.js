'use strict';
// The command checker follows a cd (and a once-assigned variable) through a command, as bash runs it, and never judges a
// write against fewer folders than bash may use: a cd joined with && moves the folder; after ; or a new line the folder
// before it stays possible (a failed cd goes on there); subshells, pipelines and background lists keep nothing; anything
// the model can't follow is judged as before. The agent's only root is a temporary folder; its working folder is the
// install folder, outside that root, as for a client whose working folder is the install root.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tp = require('../lib/tool-policy');
tp.setMemberProviders({ memberDefaults: () => ({}), ownerGrants: () => ({}) });

const FX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'policy-cd-')));
fs.mkdirSync(path.join(FX, 'sub'), { recursive: true });
const o = { cwd: tp.HUB_ROOT, roots: [FX], agentName: 'w-cd' };
const r = (cmd, opts = o) => tp.classifyCommand(cmd, opts);
const c = (cmd, opts) => r(cmd, opts).cls;
const L = (...lines) => lines.join('\n');
const inside = (cmd, opts) => assert.strictEqual(c(cmd, opts), 'write_inside', JSON.stringify(cmd));
const refused = (cmd, opts) => assert.ok(['write_outside', 'admin'].includes(c(cmd, opts)), `${JSON.stringify(cmd)}: ${c(cmd, opts)}`);
test.after(() => fs.rmSync(FX, { recursive: true, force: true }));

test('the real shapes: cd X && write, B=X; ... $B/..., and relative cd from a followed folder are allowed inside the roots', () => {
  inside(L(`cd ${FX} && cat > test/x.test.js <<'EOF'`, 'const a = 1;', 'EOF'));
  inside(`cd ${FX} && sed -i 's/a/b/' lib/x.js`);
  inside(L(`B=${FX}; cat >> $B/test/y.js <<'EOF'`, 'more', 'EOF'));
  inside(`B=${FX}; cd "$B" && echo hi > out.txt`);
  inside(`cd ${FX} && cd sub && echo hi > out.txt`);
  inside(`cd ${FX} && echo a > f &`, undefined);
  inside(`mkdir -p ${FX}/new/deep && cd ${FX}/new/deep && touch a.txt`);
});

test('after ; or a new line the write is judged in the old folder too, and the refusal says to use &&', () => {
  for (const cmd of [`cd ${FX}; cat > test/x.test.js <<'EOF'\nx\nEOF`, `cd ${FX}\necho hi > out.txt`, `cd ${FX} && echo a > f; echo b > g`]) {
    const res = r(cmd);
    assert.strictEqual(res.cls, 'write_outside', JSON.stringify(cmd));
    assert.match(res.reason, /join it with &&/);
  }
  // where the old folder is allowed too (the agent's own folder as working folder), ; is fine
  inside(`cd ${FX}/sub; echo hi > out.txt`, { ...o, cwd: FX });
});

test('still refused: a cd into hub data or a folder outside the roots, .. out of the roots, ||, pipelines, background, subshells', () => {
  // a protected folder (the suite's data guard keeps tests out of data/: the sign-in folder ~/.ssh stands in)
  const ssh = path.join(os.homedir(), '.ssh');
  refused(`cd ${ssh}; echo x > authorized_keys`);
  assert.strictEqual(c(`cd ${ssh} && echo x > authorized_keys`), 'admin', 'judged where it really lands');
  refused(`cd /etc && echo x > hosts`);
  refused(`cd ${FX} && cd .. && echo hi > out.txt`);
  refused(`cd ${FX} || echo hi > out.txt`);
  refused(`cd ${FX} | true && echo hi > out.txt`);
  refused(`cd ${FX} & echo hi > out.txt`);
  refused(`cd ${FX} && echo a > f & echo b > g`);
  refused(`(cd ${FX} && echo a > f); echo b > g`);
  inside(`(cd ${FX} && echo a > f) && cd ${FX} && echo b > g`);
});

test('a cd it cannot follow keeps the old reading: computed, ~, -, an unset variable, options, pushd, builtin/command cd', () => {
  for (const cmd of [`cd "$(echo ${FX})" && echo hi > out.txt`, 'cd ~ && echo hi > out.txt', 'cd - && echo hi > out.txt', 'cd $NOPE && echo hi > out.txt',
    `cd -P ${FX} && echo hi > out.txt`, `pushd ${FX} && echo hi > out.txt`, `builtin cd ${FX} && echo hi > out.txt`, `command cd ${FX} && echo hi > out.txt`,
    `cd ${FX}/* && echo hi > out.txt`, `cd ${FX} && popd && echo hi > out.txt`]) refused(cmd);
});

test('commands the model does not follow are judged as before: control words, functions, eval/source, trap, CDPATH', () => {
  for (const cmd of [`if true; then cd ${FX}; fi && echo hi > out.txt`, `for d in ${FX}; do cd $d && echo hi > out.txt; done`,
    `{ cd ${FX}; } && echo hi > out.txt`, `! cd /nowhere && echo hi > out.txt`, `go() { cd /etc; }; cd ${FX} && go && echo hi > out.txt`,
    `eval true; cd ${FX} && echo hi > out.txt`, `source /dev/null; cd ${FX} && echo hi > out.txt`, `trap 'cd /etc' DEBUG; cd ${FX} && echo hi > out.txt`,
    `CDPATH=/etc; cd ${FX} && echo hi > out.txt`]) refused(cmd);
});

test('variables: only a value assigned once to a literal, before the use and on every path to it', () => {
  refused(`B=${FX}; B=/etc; cd $B && echo hi > out.txt`);
  refused(`cat > $B/f; B=${FX}`);
  refused(`false && B=${FX}; cat > $B/f`);
  refused(`B=${FX}; cat > '$B/f'`);
  refused(`(B=${FX}); cat > $B/f`);
  refused(`B=${FX} cat > $B/f`);
  refused(`export B=${FX}; cat > $B/f`);
  inside(`B=${FX} && cat > "\${B}/f"`);
});

test('a cd through a link is judged where the link leads', () => {
  // a link inside the root that leads out of it (the suite's data guard keeps tests out of data/: /etc stands in)
  const link = path.join(FX, 'link');
  fs.symlinkSync('/etc', link);
  refused(`cd ${link} && echo x > motd`);
  const res = r(`cd ${link} && echo x > motd`);
  assert.ok(res.reason.includes('/etc/motd'), res.reason);
  refused(`cd ${FX} && cd link && echo x > motd`);
});

test('a descriptor copy (2>&1, >&2) is no file a verb writes; &>file, >|file and 2> file still are; a refusal names the folder', () => {
  inside(`cd ${FX} && npm install js-sha3 --no-save 2>&1 | tail -5`);
  inside(`cd ${FX} && cp a b 2>&1 >&2`);
  for (const cmd of [`cd ${FX} && echo x &>/etc/f`, `cd ${FX} && echo x >|/etc/f`, `cd ${FX} && cp a b 2> /etc/err.log`]) refused(cmd);
  // a package manager's install: its arguments are packages; the folder it runs in is judged (npm writes node_modules there)
  for (const cmd of ['pip install --quiet pycryptodome', 'pip3 install pysha3', 'npm install js-sha3', 'apt-get -y install jq']) {
    assert.deepStrictEqual(r(`cd ${FX} && ${cmd}`).paths, [FX], cmd);
    refused(cmd);   // from the install folder: the install folder is where it runs
  }
  assert.deepStrictEqual(r(`cd ${FX} && install -m 644 a.txt /etc/a.txt`).paths, ['/etc/a.txt'], 'coreutils install is a copy');
  const res = r(`cd ${tp.HUB_ROOT}/workspaces/someone-else && mkdir -p raw && touch raw/pools.json`);
  assert.ok(['write_outside', 'admin'].includes(res.cls));
  assert.ok(res.reason.includes(path.join(tp.HUB_ROOT, 'workspaces', 'someone-else', 'raw')), res.reason);
});

test('the shell scanner reports the top-level order: segments and separators, not the inside of substitutions', () => {
  const { scanCommand } = require('../lib/shell-scan');
  const s = scanCommand('cd /a && echo $(cd /b; pwd) > f; (cd /c) | cat');
  const shape = s.flow.map(e => (e.op !== undefined ? e.op : 'S'));
  assert.deepStrictEqual(shape, ['S', '&&', 'S', ';', '(', 'S', ')', '|', 'S']);
});
