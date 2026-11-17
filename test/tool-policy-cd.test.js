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

// Review r1 (Sentinel B1, also a gap of the old reading): a target still holding $NAME, $( ) or backticks is computed
// when it runs, never a relative file in the folder followed (or in the working folder).
test('a computed write target is at least a write outside the folders, wherever the command runs', () => {
  for (const cmd of [`cd ${FX} && echo hi > $HOME/.bashrc`, `cd ${FX} && echo hi > \${HOME}/.bashrc`, `cd ${FX} && echo hi > $X/.bashrc`,
    `cd ${FX} && echo hi > $(echo /home/u/.bashrc)`, `cd ${FX} && echo hi > \`echo /x\``]) refused(cmd);
  refused('echo hi > $HOME/.bashrc', { ...o, cwd: FX });   // the old gap: working folder inside the roots
  assert.strictEqual(c('echo k >> $HOME/.ssh/authorized_keys', { ...o, cwd: FX }), 'admin', '$HOME judged as the home folder too');
});

// Review r1 (Sentinel B2, Sonnet B1): a variable changed by something other than a counted NAME= is not put in.
test('variables: unset, let, (( )), read, printf -v, declare, export, IFS and the shell\'s own names are never put in', () => {
  for (const cmd of [`B=${FX}; unset B; echo hi >> $B/home/u/.bashrc`, `((B=0)); B=${FX}; cp a $B/x`, `B=${FX}; let "B=0"; echo x > $B/f`,
    `N=B; read $N <<< zz; B=${FX}; cp a $B/x`, `B=${FX}; printf -v B x; echo x > $B/f`, `N=B; declare $N=/etc; B=${FX}; cp a $B/x`,
    `IFS=x; B=${FX}/xlib; cp /etc/hostname $B`, `PWD=${FX}; cd /etc && echo key >> $PWD/authorized_keys`,
    `OLDPWD=${FX}; cd /etc && echo x > $OLDPWD/f`]) refused(cmd);
});

// Review r1 (Sentinel B3): bash's cd is logical (.. comes off the path as written); the folder through a link is also judged.
test('a cd .. after a link is judged at the logical and the physical parent', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-cd-out-'));
  try {
    // a link outside the roots that leads into them: physically .. is FX (inside), logically it is out (outside)
    fs.symlinkSync(path.join(FX, 'sub'), path.join(out, 'L'));
    refused(`cd ${out}/L && cd .. && echo hi > x`);
    inside(`cd ${FX}/sub && cd .. && echo hi > x`);
    inside(`cd ${out}/L && echo hi > x`, { ...o, roots: [FX, path.join(out, 'L')] });
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

// Review r1 (Sonnet B2, B3): options that move where operands land are judged as before; a package manager's --prefix counts.
test('relocating options and package-manager destinations are judged', () => {
  for (const cmd of [`cd ${FX} && cp -t /etc/cron.d job`, `cd ${FX} && mv -t /home/u/Documents report.txt`, `cd ${FX} && env -C /home/u touch .bashrc`,
    `cd ${FX} && npm install pkg --prefix /home/u/other`, `cd ${FX} && pip install --target=/etc/x y`, `cd ${FX} && env -u npm install /dev/null /etc/cron.d/x`,
    `export CD''PATH=/etc; cd ${FX} && cd sub && echo hi > f`]) refused(cmd);
  inside(`cd ${FX} && python3 -m pip install x`);
});

// Review r2 (Sentinel 1, Sonnet 1-5): tilde forms, brace expansion, combined and shortened options, arithmetic that
// assigns, quoted pieces of a target, rm, and a package manager behind a wrapper option.
test('round 2: ~-, ~user, ~+/.., risky braces, -rt, --target-d=, x[B=1], $[ ], ${v:B=1}, [[ ]], \'\'$HOME, rm $HOME, env -i npm', () => {
  for (const cmd of [`cd ${FX} && echo hi > ~-/x`, `cd ${FX} && echo x > ~root/.bashrc`, `cd ${FX} && echo x > ~+/../y`,
    `cd ${FX} && cp a {/etc/cron.d,/x}/job`, `cd ${FX} && touch {/etc/cron.d/x,y}`, `cd ${FX} && cp a {x,.}./y`, `cd ${FX} && echo x > {a,../b}`,
    `cd ${FX} && cp -rt /etc/cron.d job`, `cd ${FX} && mv -vt /home/u/Documents report.txt`, `cd ${FX} && cp --target-d=/etc/cron.d job`, `cd ${FX} && ln -sft /etc x`,
    `B=${FX}; x[B=1]=y; echo hi > $B/f`, `B=${FX}; : $[B=1]; echo hi > $B/f`, `B=${FX}; echo \${v:B=1}; echo hi > $B/f`, `B=${FX}; [[ 1 -eq B=1 ]]; echo hi > $B/f`,
    'env -i npm install']) refused(cmd);
  for (const cmd of ["echo k >> ''$HOME/.ssh/authorized_keys", 'echo k >> "$HOME"/.ssh/authorized_keys', 'rm $HOME/.ssh/authorized_keys', 'rm $(echo /etc/passwd)']) {
    assert.strictEqual(c(cmd, { ...o, cwd: FX }), 'admin', cmd);
  }
  // still plain: a numeric or letter range, a comma group of names, two dots inside a name
  inside(`cd ${FX} && touch a{1..3}.txt b{a..c}`);
  inside(`cd ${FX} && touch x.{js,ts}`);
  inside(`cd ${FX} && echo x > report..md`);
  inside(`cd ${FX} && env -i npm install`);
});

// Review r3 (Sonnet A, B and follow-ups): a package manager behind a wrapper the scanner doesn't model; braces expanded
// and each result judged (ordinary scaffolding stays allowed, empty alternatives that make .. or / don't); -t DIR;
// backslashes; variables kept for [ "$a" = b ] and ${x:-y}.
test('round 3: uv pip --target, brace results judged one by one, cp -t DIR, .\\./y, narrower variable switch-off', () => {
  for (const cmd of ['uv pip install --target /etc/cron.d x', 'eatmydata npm install --prefix /etc/x pkg', `cd ${FX} && touch .{,}./x`,
    `cd ${FX} && touch ..{,}/x`, `cd ${FX} && touch {,}/etc/cron.d/x`, `cd ${FX} && echo x > .\\./y`]) refused(cmd);
  refused(`cp -t /etc/cron.d job`, { ...o, cwd: FX });   // DIR judged even where the working folder is inside the roots
  for (const cmd of [`cd ${FX} && touch src/{index.js,app.js}`, `cd ${FX} && touch {README.md,LICENSE}`, `cd ${FX} && cp config{,.bak}`,
    `cd ${FX} && mkdir -p proj/{src/lib,test}`, `cd ${FX} && uv pip install x`, `B=${FX}; [ "$a" = b ] && cat > $B/f`, `B=${FX}; x=\${y:-z}; cat > $B/f`]) inside(cmd);
  refused(`B=${FX}; a[0]=1; cat > $B/f`);
});

// Review r4 (Sentinel 1; Sonnet 1-3, 7): wait -p assigns; a target past the brace bound keeps its absolute folder; a
// manager behind a flag-taking wrapper; an empty brace word can't hide the destination; "."./x is one word.
test('round 4: wait -p, absolute targets past the brace bound, xvfb-run -a npm --prefix, cp a DEST {,}, interior quotes', () => {
  refused(`B=${FX}; true & wait -p B; echo hi >> $B/home/u/.bashrc`);
  assert.strictEqual(c(`cd ${FX} && touch /etc/cron.d/{1..100}`), 'admin', 'past the bound, still judged where it is');
  for (const cmd of [`cd ${FX} && xvfb-run -a npm install --prefix /etc/cron.d pkg`, `cd ${FX} && firejail --quiet pip install --target /etc/cron.d x`,
    `cd ${FX} && cp a /etc/cron.d/x {,}`, `cd ${FX} && touch "."./x`]) refused(cmd);
  inside(`cd ${FX} && cp a b`);
  inside(`cd ${FX} && npm install`);
});

// Review r5 (Sonnet A, B): every path inside a computed target is judged (~/ in a substitution, an escaped or braced
// path, a path after a leading /); a manager word that is only an option's value keeps the copy reading's -t DIR.
test('round 5: paths inside a computed target, env -u npm install -t DIR', () => {
  for (const cmd of [`cd ${FX} && cp k.pub $(echo ~/.ssh/authorized_keys)`, `cd ${FX} && tee \`echo ~/.ssh/authorized_keys\``,
    `cd ${FX} && touch $(echo \\/etc/cron.d/x)`, `cd ${FX} && touch $(echo {/etc/cron.d/x,y})`, `cd ${FX} && touch /$(echo /etc/cron.d/x)`,
    `cd ${FX} && env -u npm install -t/etc/cron.d a`, `cd ${FX} && env -u npm install --target-directory=/etc/cron.d a`]) {
    assert.strictEqual(c(cmd), 'admin', cmd);
  }
  inside(`cd ${FX} && pip install requests`);
});
