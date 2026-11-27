'use strict';
// "Protect your Maestro's own code": what counts as a program file (hub home = install folder, symlinks) and what counts as a write
// (reads are free; a command that can't be read is refused only when it might write).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tp = require('../lib/tool-policy');
const { createCodeProtect, shellWriteTargets, mightWrite } = require('../lib/code-protect');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-scope-'));
const mk = (root, ...dirs) => { for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true }); };
const make = (hubRoot, hubHome) => createCodeProtect({ stateOf: () => 'on', hubRoot, hubHome });

test('fresh layout (hub home inside the install): workspace, Files folder, share/common, member and team folders are free; program files are not', () => {
  const app = tmp();
  mk(app, 'lib', 'workspaces/sam', 'hub-home/share/sam', 'hub-home/share/common', 'hub-home/users/m1', 'hub-home/share/team-a');
  const cp = make(app, path.join(app, 'hub-home'));
  for (const f of ['workspaces/sam/a.md', 'hub-home/share/sam/a.md', 'hub-home/share/common/a.md', 'hub-home/users/m1/a.md', 'hub-home/share/team-a/a.md']) {
    assert.strictEqual(cp.isProtectedPath(path.join(app, f)), false, f);
  }
  assert.strictEqual(cp.isProtectedPath(path.join(app, 'lib/x.js')), true);
});

test('code-protect\'s list of the hub home\'s own folders matches lib/hub-home BACKUP_FOLDERS (read as text: loading it works out the hub home)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'hub-home.js'), 'utf8');
  const folders = JSON.parse(/const FOLDERS = (\[[^\]]*\]);/.exec(src)[1].replace(/'/g, '"'));
  const recordings = /const RECORDINGS = '([^']+)';/.exec(src)[1];
  assert.match(src, /const BACKUP_FOLDERS = \[\.\.\.FOLDERS, RECORDINGS\];/);
  assert.deepStrictEqual(require('../lib/code-protect').HOME_FOLDERS, [...folders, recordings]);
});

test('hub home = install folder: its own folders are free, program files and the behaviour file are protected', () => {
  const app = tmp();
  mk(app, 'lib', 'share/sam', 'share/common', 'users/m1/files', 'medical', 'legal', 'call-recordings', 'data');
  const cp = make(app, app);
  for (const f of ['share/sam/a.md', 'share/common/a.md', 'users/m1/files/a.md', 'medical/x', 'legal/x', 'call-recordings/x']) {
    assert.strictEqual(cp.isProtectedPath(path.join(app, f)), false, f);
  }
  for (const f of ['lib/x.js', 'server.js', 'data/behaviour-reviews.json']) assert.strictEqual(cp.isProtectedPath(path.join(app, f)), true, f);
});

test('symlinked install: the Files folder file is free by its real and its symlinked path; program files are protected by both', () => {
  const b = tmp();
  const real = path.join(b, 'real-app');
  mk(real, 'hub-home/share/sam', 'lib');
  const link = path.join(b, 'app'); fs.symlinkSync(real, link);
  const layouts = { 'root real, home through the link': make(real, path.join(link, 'hub-home')), 'both through the link': make(link, path.join(link, 'hub-home')) };
  for (const [name, cp] of Object.entries(layouts)) {
    for (const base of [real, link]) {
      assert.strictEqual(cp.isProtectedPath(path.join(base, 'hub-home/share/sam/a.md')), false, `${name}: files ${base}`);
      assert.strictEqual(cp.isProtectedPath(path.join(base, 'lib/x.js')), true, `${name}: lib ${base}`);
    }
  }
});

const app = tmp();
mk(app, 'lib', 'hub-home/share/sam');
const files = path.join(app, 'hub-home/share/sam');
const cpOn = make(app, path.join(app, 'hub-home'));
const wp = (c, cwd = files) => cpOn.commandWritesProtected(c, cwd);

test('reads of a program file do not count as writes', () => {
  const L = path.join(app, 'lib/x.js');
  for (const c of [`sed -n 1,5p ${L}`, `cp ${L} /tmp/x.js`, `ln -s ${L} ${files}/link`, `ls ${app}/lib`, `cat ${L}`, `stat ${L}`, `find ${app} -name x.js`,
    `grep -rn foo ${app}/lib`, `du -sh ${app}`, `test -f ${L}`, `[ -e ${L} ]`, `cd ${app} && ls`, `ls ${app} 2>/dev/null`, `ls ${app} 2>&1 | head`]) {
    assert.strictEqual(wp(c), false, c);
  }
});

test('real writes to a program file still count', () => {
  const L = path.join(app, 'lib/x.js');
  for (const c of [`sed -i s/a/b/ ${L}`, `sed -Ei s/a/b/ ${L}`, `cp /tmp/y.js ${app}/lib/`, `cp -t ${app}/lib /tmp/y.js`, `mv ${L} /tmp/`,
    `ln -s /tmp/y ${app}/lib/y`, `echo x > ${L}`, `tee ${L}`, `touch ${app}/lib/new.js`, `perl -pi -e s/a/b/ ${L}`, `dd if=/tmp/a of=${L}`]) {
    assert.strictEqual(wp(c), true, c);
  }
});

test('shellWriteTargets: per-program targets', () => {
  const t = (c) => shellWriteTargets(c, '/w');
  assert.deepStrictEqual(t('sed -n 1p /a/b'), []);
  assert.deepStrictEqual(t('sed -e s/a/b/ -i /a/b'), ['/a/b']);
  // a copy writes its destination and, when that is a folder, DEST/<source name>; never the source
  assert.deepStrictEqual(t('cp /a /b').sort(), ['/b', '/b/a']);
  // ln TARGET makes a link named after the target in the current folder
  assert.ok(t('ln -s /a').includes('/w/a'));
  assert.ok(!t('ln -s /a').includes('/a'), 'the target of a symbolic link is not written');
  assert.deepStrictEqual(t('echo hi 2>&1'), []);
});

test('shellWriteTargets: copies into a folder, hard links, wrappers, lookups, here-strings', () => {
  const t = (c) => shellWriteTargets(c, '/w');
  // into a folder: the file lands there under the source's name (data/ is exempt, but some files in it are not)
  assert.ok(t('cp /tmp/behaviour-reviews.json /app/data/').includes('/app/data/behaviour-reviews.json'));
  assert.ok(t('cp -t /app/data /tmp/put-aside.json').includes('/app/data/put-aside.json'));
  // a hard link is a second name for the very same file: the source counts
  assert.ok(t('ln /app/lib/x.js /w/x.js').includes('/app/lib/x.js'));
  assert.ok(t('cp -l /app/lib/x.js /w/x.js').includes('/app/lib/x.js'));
  assert.ok(t('cp -al /app/lib /w/lib').includes('/app/lib'));
  assert.ok(!t('ln -s /app/lib/x.js /w/x.js').includes('/app/lib/x.js'), 'a symbolic link is not');
  assert.ok(!t('cp /app/lib/x.js /w/x.js').includes('/app/lib/x.js'), 'a plain copy is not');
  // wrappers with options that take a value: the real program is found
  assert.ok(t('sudo -u root rm /app/lib/x.js').includes('/app/lib/x.js'));
  assert.ok(t('timeout 5 rm /app/lib/x.js').includes('/app/lib/x.js'));
  assert.ok(t('nice -n 5 touch /app/lib/y.js').includes('/app/lib/y.js'));
  assert.ok(t('env A=b rm /app/lib/x.js').includes('/app/lib/x.js'));
  // command -v / -V only look a name up
  assert.deepStrictEqual(t('command -v cp /app/lib/x.js /tmp'), []);
  // a here-string's word is not an operand: it never hides the destination
  assert.ok(t('cp /tmp/y /app/lib/ <<<word').includes('/app/lib'));
  // perl -C takes no separate value
  assert.ok(t('perl -C -pi -e s/a/b/ /app/lib/x.js').includes('/app/lib/x.js'));
});

test('shellWriteTargets: flags of rm, touch, mkdir, truncate never hide the path they act on', () => {
  const t = (c) => shellWriteTargets(c, '/w');
  // rm -r and rm -d are flags, not options with a value: the next word is a path being deleted
  assert.deepStrictEqual(t('rm -r /app/lib'), ['/app/lib']);
  assert.deepStrictEqual(t('rm -d /app/lib/d'), ['/app/lib/d']);
  assert.deepStrictEqual(t('rm -rf /app/lib'), ['/app/lib']);
  assert.deepStrictEqual(t('rmdir -p /app/lib/d'), ['/app/lib/d']);
  // options that do take a value: the value is not a target, the operand is
  assert.deepStrictEqual(t('touch -d now /app/lib/x'), ['/app/lib/x']);
  assert.deepStrictEqual(t('mkdir -m 700 /app/lib/n'), ['/app/lib/n']);
  assert.deepStrictEqual(t('truncate -s 0 /app/lib/x.js'), ['/app/lib/x.js']);
  assert.deepStrictEqual(t('tee -a /app/lib/x.js'), ['/app/lib/x.js']);
  assert.deepStrictEqual(t('install -d /app/lib/n'), ['/app/lib/n']);
  assert.deepStrictEqual(t('cp -r /app/lib /tmp/out').sort(), ['/tmp/out', '/tmp/out/lib']);
  assert.deepStrictEqual(t('perl -pi -e s/a/b/ /app/lib/x.js'), ['/app/lib/x.js']);
});

test('mightWrite: reads are not, redirections and writing programs are', () => {
  assert.strictEqual(mightWrite('ls -la /tmp | head'), false);
  assert.strictEqual(mightWrite('cat a 2>&1'), false);
  for (const c of ['echo x > f', 'cat a | tee f', 'sed -n 1p a', 'python3 -c 1']) assert.strictEqual(mightWrite(c), true, c);
});

test('onlyReads: only commands made of programs known to only read, with no redirection or substitution', () => {
  const { onlyReads } = require('../lib/code-protect');
  for (const c of ['ls -la /tmp | head', 'cat a 2>&1', 'grep -rn x . | wc -l', 'cd /tmp && ls']) assert.strictEqual(onlyReads(c), true, c);
  for (const c of ['echo x > f', 'mytool --sync lib', 'ls; mytool', 'echo $(mytool)', 'echo `mytool`', 'cat <(mytool)', 'sort -o f a', 'A=1 stat f', '']) {
    assert.strictEqual(onlyReads(c), false, c);
  }
});

test('policy: a command that cannot be read is let through only when it certainly only reads', () => {
  const broken = { state: () => ({ on: true }), isProtectedPath: () => false, commandWritesProtected: () => { throw new Error('unreadable'); } };
  tp.setCodeProtectProvider(() => broken);
  try {
    const agent = { name: 'sam', category: 'primary' };
    const w = (command) => tp.decide({ agent, tool: 'Bash', input: { command }, cwd: app }).protectedCode === true;
    assert.strictEqual(w('ls -la /tmp'), false);
    assert.strictEqual(w(`echo x > ${app}/lib/x.js`), true);
    assert.strictEqual(w(`maintenance-tool --rewrite ${app}/lib`), true, 'an unknown program may write: refused');
  } finally { tp.setCodeProtectProvider(null); }
});

test('a symlink in data/ or a workspace cannot carry a write into the program files', () => {
  const b = tmp();
  mk(b, 'lib', 'data', 'workspaces/sam', 'hub-home/share/sam');
  fs.symlinkSync(path.join(b, 'lib'), path.join(b, 'data', 'l'));
  fs.symlinkSync(path.join(b, 'lib'), path.join(b, 'workspaces', 'sam', 'l'));
  fs.writeFileSync(path.join(b, 'lib', 'x.js'), '');
  fs.symlinkSync(path.join(b, 'lib', 'x.js'), path.join(b, 'data', 'xlink'));
  const cp = make(b, path.join(b, 'hub-home'));
  for (const p of ['data/l/x.js', 'data/l/new.js', 'workspaces/sam/l/x.js', 'data/xlink']) assert.strictEqual(cp.isProtectedPath(path.join(b, p)), true, p);
  assert.strictEqual(cp.commandWritesProtected(`echo x > ${b}/data/l/x.js`, path.join(b, 'workspaces', 'sam')), true);
  assert.strictEqual(cp.isProtectedPath(path.join(b, 'data', 'plain.json')), false, 'an ordinary data file stays free');
});

test('a quoted > in a read is text, not a redirection', () => {
  const L = path.join(app, 'lib/x.js');
  for (const c of [`grep '>' ${L}`, `grep -n ">=" ${L}`, `grep -c "a > b" ${L}`]) assert.strictEqual(wp(c), false, c);
  assert.strictEqual(wp(`echo '>' > ${L}`), true, 'a real redirection after a quoted > still counts');
});

test('a symlink whose target does not exist yet, and `..` after a symlink, are followed as the kernel follows them', () => {
  const b = tmp();
  mk(b, 'lib/sub', 'workspaces/sam', 'hub-home/share/sam');
  const ws = path.join(b, 'workspaces', 'sam');
  fs.symlinkSync(path.join(b, 'lib', 'new.js'), path.join(ws, 'dangling'));   // its target does not exist yet
  fs.symlinkSync(path.join(b, 'lib', 'sub'), path.join(ws, 'l'));
  const cp = make(b, path.join(b, 'hub-home'));
  assert.strictEqual(cp.isProtectedPath(path.join(ws, 'dangling')), true, 'a write through it makes lib/new.js');
  assert.strictEqual(cp.commandWritesProtected(`echo x > ${ws}/dangling`, ws), true);
  // l/../x.js is lib/x.js (the .. leaves lib/sub), not workspaces/sam/x.js
  assert.strictEqual(cp.commandWritesProtected(`echo x > ${ws}/l/../x.js`, ws), true);
  assert.strictEqual(cp.commandWritesProtected('echo x > l/../x.js', ws), true, 'relative too');
  assert.strictEqual(cp.commandWritesProtected('cd l && echo x > ../x.js', ws), true, 'after a cd into the link');
  assert.strictEqual(cp.commandWritesProtected(`echo x > ${ws}/plain/../notes.md`, ws), false, 'an ordinary .. stays free');
});

test('>&FILE, >& FILE, {fd}>FILE and <>FILE write; >&2, 2>&1 and >&- do not', () => {
  const L = path.join(app, 'lib/x.js');
  for (const c of [`echo x >&${L}`, `echo x >& ${L}`, `exec {fd}>${L}`, `exec 3<>${L}`]) assert.strictEqual(wp(c), true, c);
  for (const c of ['echo x >&2', 'ls 2>&1', 'ls >&-']) assert.strictEqual(wp(c), false, c);
  assert.strictEqual(mightWrite(`echo x >&${L}`), true);
  assert.strictEqual(mightWrite('ls 2>&1'), false);
});

test('onlyReads: a program named by a path, and programs that can write a file, are not read-only', () => {
  const { onlyReads } = require('../lib/code-protect');
  for (const c of ['./ls', '/tmp/x/cat a', 'uniq in out', 'xxd in out', 'file -C', 'rg --pre ./x pattern']) assert.strictEqual(onlyReads(c), false, c);
});

test('a redirection glued to a word (x>FILE, x>>FILE, x>&FILE, cat<in>out) and {fd}<>FILE write; a quoted one does not', () => {
  const L = path.join(app, 'lib/a.js');
  for (const c of [`echo x>${L}`, `printf a>>${L}`, `echo x>&${L}`, `cat<in>${L}`, `exec {fd}<>${L}`, `echo a=>${L}`]) assert.strictEqual(wp(c), true, c);
  for (const c of [`echo 'x>${L}'`, `echo "x>${L}"`, `echo x\\>${L}`, 'ls x 2>&1', 'cat<in']) assert.strictEqual(wp(c), false, c);
  assert.deepStrictEqual(shellWriteTargets(`echo x>${L}`, files), [L]);
});

test('a path whose real form cannot be worked out (lstat fails with EMFILE) is refused, never judged as written', () => {
  const b = tmp();
  mk(b, 'lib', 'workspaces/sam', 'hub-home/share/sam');
  const ws = path.join(b, 'workspaces', 'sam');
  fs.symlinkSync(path.join(b, 'lib'), path.join(ws, 'l'));
  const cp = make(b, path.join(b, 'hub-home'));
  const orig = fs.lstatSync;
  fs.lstatSync = (p, ...r) => { if (String(p) === path.join(ws, 'l')) { const e = new Error('too many open files'); e.code = 'EMFILE'; throw e; } return orig(p, ...r); };
  try {
    assert.strictEqual(cp.isProtectedPath(path.join(ws, 'l', 'x.js')), true);
  } finally { fs.lstatSync = orig; }
  assert.strictEqual(cp.isProtectedPath(path.join(ws, 'missing', 'x.js')), false, 'a component that is not there (ENOENT) is still free');
});

test('onlyReads: an assignment in front (PATH=…), a function defined in the command, and less are not read-only; >/dev/null is', () => {
  const { onlyReads } = require('../lib/code-protect');
  for (const c of ['PATH=. ls', 'PATH=/tmp/x:$PATH cat f', 'ls () { :; }; ls', 'less -o log f', 'more f']) assert.strictEqual(onlyReads(c), false, c);
  for (const c of ['ls x 2>/dev/null', 'grep -r a . >/dev/null 2>&1', 'cat f &>/dev/null']) assert.strictEqual(onlyReads(c), true, c);
  assert.strictEqual(onlyReads('ls 2>/dev/nullx'), false);
});

test('a backslash in a file name on Linux is a character, not a separator', { skip: path.sep === '\\' }, () => {
  const b = tmp();
  mk(b, 'lib', 'workspaces/sam', 'hub-home/share/sam');
  const cp = make(b, path.join(b, 'hub-home'));
  // one file named `a\..\..\notes.md` inside the workspace
  assert.strictEqual(cp.isProtectedPath(path.join(b, 'workspaces', 'sam', 'a\\..\\..\\notes.md')), false);
  assert.strictEqual(cp.isProtectedPath(path.join(b, 'lib', 'a\\..\\..\\workspaces\\x')), true);
});

test('a > or < inside $( ), $(( )), ${ }, `…` or <( ) is not split off as a redirection of the outer command', () => {
  const inLib = path.join(app, 'lib');
  for (const c of ['echo $(cat x 2>&1)', 'echo $((a>b))', 'echo `ls 2>&1`', 'cat <(grep x 2>&1)', 'echo ${v:-a>b}', 'echo "$(cat <in)"']) {
    assert.strictEqual(cpOn.commandWritesProtected(c, inLib), false, c);
  }
  assert.strictEqual(cpOn.commandWritesProtected('echo $(cat x)>lib/a.js', app), true, 'a redirection after the substitution still counts');
});

test('~/… keeps its .. for the kernel-style walk (not folded before a symlink is followed)', () => {
  const t = shellWriteTargets('echo x > ~/l/../x.js', '/');
  assert.deepStrictEqual(t, [`${os.homedir()}/l/../x.js`]);
});

test('a { inside $( ) or a ( inside ${ } does not hide a redirection after the substitution; the same expansion alone is free', () => {
  const pairs = [['echo $(echo {)', '>lib/a.js'], ['echo ${v:-(}', '>lib/a.js'], ['echo $(case x in x) echo;; esac)', '>lib/a.js'], ['echo $[a+1]', '>lib/a.js'], ['echo ${v:-<(}', '>lib/a.js'], ['echo $[a<(1)]', '>lib/a.js']];
  for (const [e, r] of pairs) {
    assert.strictEqual(cpOn.commandWritesProtected(e, app), false, e);
    assert.strictEqual(cpOn.commandWritesProtected(e + r, app), true, e + r);
  }
  assert.strictEqual(cpOn.commandWritesProtected('echo $[a>b]', path.join(app, 'lib')), false, '$[ ] is arithmetic');
});

test('git -C through a symlink and ..: judged by the repository git really enters', () => {
  const b = tmp();
  mk(b, '.git', 'lib/sub', 'workspaces/sam/.git', 'hub-home/share/sam');
  const ws = path.join(b, 'workspaces', 'sam');
  fs.symlinkSync(path.join(b, 'lib', 'sub'), path.join(ws, 'l'));
  const cp = make(b, path.join(b, 'hub-home'));
  assert.strictEqual(cp.commandWritesProtected(`git -C ${ws}/l/.. checkout -- .`, ws), true, 'l/.. is lib/, in the install');
  // bash's cd (no -P) applies .. to its logical folder: `cd l/..` stays in the workspace; -P goes to lib/
  assert.strictEqual(cp.commandWritesProtected('cd l/.. && git checkout -- .', ws), false, 'cd -L: back in the workspace');
  assert.strictEqual(cp.commandWritesProtected('cd l && cd .. && git checkout -- .', ws), false, 'cd l then cd ..: the workspace');
  assert.strictEqual(cp.commandWritesProtected('cd -P l/.. && git checkout -- .', ws), true, 'cd -P: lib/, in the install');
  assert.strictEqual(cp.commandWritesProtected('cd l && git checkout -- .', ws), true, 'inside the link: lib/sub');
  assert.strictEqual(cp.commandWritesProtected('cd l && echo x > ../x.js', ws), true, 'a redirection opens ../ physically: lib/x.js');
  assert.strictEqual(cp.commandWritesProtected('cd l/.. && echo x > notes.md', ws), false, 'cd -L back in the workspace: its own file');
  assert.strictEqual(cp.commandWritesProtected(`git -C ${ws} checkout -- .`, ws), false, 'the workspace\'s own repository');
  // a lookup that fails (EMFILE) on the link while judging git -C: the policy refuses
  const orig = fs.lstatSync;
  fs.lstatSync = (p, ...r) => { if (String(p) === path.join(ws, 'l')) { const e = new Error('too many open files'); e.code = 'EMFILE'; throw e; } return orig(p, ...r); };
  tp.setCodeProtectProvider(() => cp);
  try {
    assert.throws(() => cp.commandWritesProtected(`git -C ${ws}/l/.. checkout -- .`, ws));
    const agent = { name: 'sam', category: 'primary' };
    assert.strictEqual(tp.decide({ agent, tool: 'Bash', input: { command: `git -C ${ws}/l/.. checkout -- .` }, cwd: ws }).protectedCode, true);
  } finally { fs.lstatSync = orig; tp.setCodeProtectProvider(null); }
});

test('cd is followed in order as bash follows it: options, --, two relative steps, a failed cd, cd -, and a cd that cannot be followed', () => {
  const b = tmp();
  mk(b, '.git', 'lib/sub', 'workspaces/sam/.git', 'workspaces/sam/a', 'hub-home/share/sam');
  const ws = path.join(b, 'workspaces', 'sam');
  fs.symlinkSync(path.join(b, 'lib'), path.join(ws, 'a', 'l'));   // a link inside the first folder
  const cp = make(b, path.join(b, 'hub-home'));
  const W = (c, cwd = ws) => cp.commandWritesProtected(c, cwd);
  // refused: the write or the change lands in the program files
  for (const [c, cwd] of [
    ['cd a && cd l && echo x > y.js', ws],
    ['cd -L lib && echo x > a.js', b], ['cd -- lib && echo x > a.js', b], ['cd -LP lib && echo x > a.js', b],
    ['cd -- lib && git checkout -- .', b], ['if true; then cd ../../lib; fi; echo x > a.js', ws], ['(cd ../../lib; echo x > a.js)', ws],
    ['cd lib/sub && cd .. && echo x > a.js', b],
    [`cd ${b}/lib && cd /tmp && cd - && echo x > a.js`, ws],
    ['cd missing-folder; git checkout -- .', b],
    ['cd "$D" && echo x > out.txt', ws], ['CDPATH=/x cd lib && echo x > a.js', ws], ['pushd a; popd; echo x > b.js', ws],
    ['cd "$D" && git checkout -- .', ws],
  ]) assert.strictEqual(W(c, cwd), true, c);
  // free: the workspace's own work
  for (const c of ['cd a && echo x > notes.md', 'cd /nonexistent-folder; git checkout -- .', 'cd a && cd .. && git checkout -- .',
    'cd "$D" && echo x > /tmp/abs-out.txt', 'cd "$D" && cat f', `cd ${b}/lib && cd ${ws} && echo x > n.md`.replace(`cd ${b}/lib && `, ''),
    'cd a b && echo x > notes.md']) {
    assert.strictEqual(W(c), false, c);
  }
});

test('cd walk: redirections are not operands, a folder without search permission, an inherited OLDPWD, control words, nested code', () => {
  const b = tmp();
  mk(b, '.git', 'lib', 'workspaces/sam/.git', 'workspaces/sam/a', 'hub-home/share/sam');
  const ws = path.join(b, 'workspaces', 'sam');
  const cp = make(b, path.join(b, 'hub-home'));
  const W = (c, cwd) => cp.commandWritesProtected(c, cwd);
  assert.strictEqual(W(`cd ${ws} 2>/dev/null && echo x > notes.md`, b), false, 'cd into the workspace with 2>/dev/null');
  assert.strictEqual(W('cd ../../lib 2>/dev/null && echo x > a.js', ws), true, 'cd into lib/ with 2>/dev/null');
  assert.strictEqual(W('cd - && echo x > a.js', ws), true, 'the first cd -: OLDPWD from the environment, unknown');
  for (const c of ['cd ../../lib; if false; then cd /tmp; fi; echo x > a.js', 'cd ../../lib; while false; do cd /tmp; done; echo x > a.js',
    'cd ../../lib; { cd /tmp; }; echo x > a.js', 'cd ../../lib; if true; then echo $(echo x > a.js); fi']) assert.strictEqual(W(c, ws), true, c);
  // a folder that stat says is one, but cd can't search: the cd fails, the shell stays in lib/
  const orig = fs.accessSync;
  fs.accessSync = (p, ...r) => { if (String(p) === path.join(ws, 'a')) { const e = new Error('permission denied'); e.code = 'EACCES'; throw e; } return orig(p, ...r); };
  try { assert.strictEqual(W(`cd ../../lib; cd ${ws}/a; echo x > a.js`, ws), true); } finally { fs.accessSync = orig; }
});

test('a separate repo in the hub home: clone into it, cd after a clone, a subshell, and a literal variable are free; the install stays protected', () => {
  const home = tmp();
  const inst = path.join(home, 'agent-hub-5.1.0');
  mk(home, 'agent-hub-5.1.0/.git', 'agent-hub-5.1.0/lib', 'share/maestro/site/.git', 'share/review/assets');
  const cp = make(inst, home);
  const S = path.join(home, 'share/maestro/site');
  const R = path.join(home, 'share/review');
  const W = (c) => cp.commandWritesProtected(c, inst);   // the agents' shells start in the install folder
  for (const c of [
    `git clone ${S} ${R}/film`,
    `git clone ${S} ${R}/film && cd ${R}/film && git checkout -b v10d`,
    `cd ${S} && git checkout -q -b film master && python3 ${R}/assets/apply.py ${S}`,
    `(cd ${S} && git checkout -q -b film master)`,
    `D=${R}/window && mkdir -p $D && cp a.png b.png $D/`,
    `D=${R}/w; mkdir -p "$D"; cp a b "\${D}/"`,
    `mkdir -p ${R}/new && cd ${R}/new && echo x > notes.md`,
  ]) assert.strictEqual(W(c), false, c);
  for (const c of [
    `echo x > ${inst}/lib/x.js`,
    `cd ${inst} && git checkout -- .`,
    `git clone ${S} ${inst}/lib/site`,
    `cd ${inst}/lib && git clone ${S}`,
    `git clone --depth 1 -b main ${S} lib/site`,
    `D=${inst}/lib && cp a.js $D/`,
    'cp a.js $UNKNOWN/',
    `(cd ${S}) && git checkout -- .`,
    `D=${R}/w && read D && cp a.js $D/`,
    `git clone ${S} ${R}/film; cd ${R}/film; git checkout -- .`,
  ]) assert.strictEqual(W(c), true, c);
});
