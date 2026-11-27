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
  for (const c of ['ls -la /tmp | head', 'cat a 2>&1', 'grep -rn x . | wc -l', 'cd /tmp && ls', 'A=1 stat f']) assert.strictEqual(onlyReads(c), true, c);
  for (const c of ['echo x > f', 'mytool --sync lib', 'ls; mytool', 'echo $(mytool)', 'echo `mytool`', 'cat <(mytool)', 'sort -o f a', '']) {
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
