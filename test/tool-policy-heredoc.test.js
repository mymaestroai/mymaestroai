'use strict';
// Shell command classification across heredocs, newlines, background &, redirects and malformed input.
// The flaw: classifyCommand cut the command after the first heredoc's opening line, so everything after the
// heredoc body went unclassified, newlines were not command separators, and `&>` was not seen as a write.
// Paths come from tp.HUB_ROOT, os.homedir() and /tmp only, so the file passes in any install location.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const tp = require('../lib/tool-policy');
tp.setMemberProviders({ memberDefaults: () => ({}), ownerGrants: () => ({}) });

const HOME = os.homedir();
const head = { name: 'gp', category: 'primary' };
const worker = { name: 'haiku', category: 'worker' };
const lead = { name: 'maestro', category: 'primary', lead: true };
const o = { cwd: path.join(tp.HUB_ROOT, 'workspaces', 'gp'), roots: tp.policyFor(head).roots, agentName: 'gp' };
const c = (cmd) => tp.classifyCommand(cmd, o).cls;
const cr = (cmd) => (['read', 'read_outside'].includes(c(cmd)) ? 'read' : c(cmd));   // reads of any kind count as reads
const L = (...lines) => lines.join('\n');
const RM = 'rm -rf ~/projects';
const SEV = (cls) => { const i = tp.CLASSES.indexOf(cls); assert.ok(i >= 0, `unknown class ${cls}`); return i; };
const notDestroy = (cmd, msg) => assert.notStrictEqual(c(cmd), 'destroy', msg || JSON.stringify(cmd));
const isDestroy = (cmd, msg) => assert.strictEqual(c(cmd), 'destroy', msg || JSON.stringify(cmd));

test('the reported flaw: a command after a heredoc is classified, and the decision follows', () => {
  const cmd = L("cat > /tmp/x <<'EOF'", 'body', 'EOF', RM);
  assert.strictEqual(c(cmd), 'destroy');
  assert.strictEqual(c(RM), 'destroy', 'the same command alone');
  assert.strictEqual(tp.decide({ agent: head, tool: 'Bash', input: { command: cmd }, cwd: o.cwd }).decision, 'deny', 'head never destroys');
  assert.strictEqual(tp.decide({ agent: lead, tool: 'Bash', input: { command: cmd }, cwd: path.join(tp.HUB_ROOT, 'workspaces', 'maestro') }).decision, 'ask', 'lead asks for destroy');
  assert.strictEqual(c(L("cat > /tmp/x <<'EOF'", 'body', 'EOF')), 'write_inside', 'the heredoc alone is an inside write');
});

test('several heredocs, then a command', () => {
  assert.strictEqual(c(L("cat > /tmp/a <<'A'", 'one', 'A', "cat > /tmp/b <<'B'", 'two', 'B', 'cp report.md ~/Desktop/report.md')), 'write_outside');
  assert.strictEqual(c(L("cat > /tmp/a <<'A'", 'one', 'A', "cat > /tmp/b <<'B'", 'two', 'B', RM)), 'destroy');
  assert.strictEqual(c(L('cat <<A <<B', 'first', 'A', 'second', 'B', 'cp report.md ~/Desktop/report.md')), 'write_outside', 'two heredocs on one line');
  assert.strictEqual(c(L("cat > /tmp/a <<'A'", 'one', 'A', "cat > /tmp/b <<'B'", 'two', 'B')), 'write_inside', 'nothing outside');
});

test('newline separates commands: no false write_outside from folding lines into mkdir', () => {
  assert.strictEqual(c(L('mkdir -p /tmp/a', "cat > /tmp/a/f <<'IDEA'", 'some text > here', 'IDEA')), 'write_inside');
  assert.strictEqual(c(L('mkdir -p /tmp/a', 'echo hi > /tmp/a/f')), 'write_inside');
  assert.strictEqual(c(L('echo hi', RM)), 'destroy', 'a second line is a second command');
  assert.strictEqual(c('rm \\\n-rf ~/projects'), 'destroy', 'backslash-newline joins lines');
  assert.strictEqual(c('mkdir -p /tmp/a \\\n  /tmp/b'), 'write_inside', 'joined continuation is one command');
  assert.strictEqual(cr(L('# rm -rf ~/projects', 'ls')), 'read', 'a whole-line comment is dropped');
  assert.strictEqual(cr('ls # rm -rf ~/projects'), 'read', 'a trailing comment is dropped');
  notDestroy('echo "line one\nrm -rf ~/projects"', 'a newline inside quotes does not split');
});

test('decide(): worker denies through Bash, mcp__hub__Bash and run_job', () => {
  const target = path.join(tp.HUB_ROOT, 'workspaces', 'gp', 'f');
  const command = "cat > /tmp/w <<'EOF'\nx\nEOF\ntouch " + target;
  const cwd = path.join(tp.HUB_ROOT, 'workspaces', 'haiku');
  assert.strictEqual(tp.decide({ agent: worker, tool: 'Bash', input: { command }, cwd }).decision, 'deny');
  assert.strictEqual(tp.decide({ agent: worker, tool: 'mcp__hub__Bash', input: { command }, cwd }).decision, 'deny');
  assert.strictEqual(tp.decide({ agent: worker, tool: 'run_job', input: { name: 'j', command }, cwd }).decision, 'deny');
  assert.strictEqual(tp.decide({ agent: worker, tool: 'Bash', input: { command: "cat > /tmp/w <<'EOF'\nx\nEOF\n" + RM }, cwd }).decision, 'deny', 'destroy after a heredoc');
  assert.strictEqual(tp.decide({ agent: worker, tool: 'Bash', input: { command: "cat > /tmp/w <<'EOF'\nx\nEOF" }, cwd }).decision, 'allow', 'the heredoc alone stays allowed');
  assert.strictEqual(tp.decide({ agent: worker, tool: 'Bash', input: { command: "cat > /tmp/w <<'EOF'\nx\nEOF\ncp a ~/Desktop/b" }, cwd }).decision, 'deny', 'write_outside after a heredoc');
});

test('not a heredoc: shifts, here-strings, escaped and quoted << keep classifying the next line', () => {
  isDestroy(L('echo $(( 1<<3 ))', RM), 'arithmetic shift');
  isDestroy(L('(( x <<= 2 ))', RM), 'shift-assign');
  isDestroy(L('cat <<< hello', RM), 'here-string');
  isDestroy(L('cat <<<"some text"', RM), 'here-string, no space');
  isDestroy(L('echo \\<<EOF', RM), 'escaped');
  isDestroy(L('echo "<<EOF"', RM), 'double-quoted');
  isDestroy(L("echo '<<EOF'", RM), 'single-quoted');
  isDestroy(L('# cat <<EOF', RM), 'in a comment');
  isDestroy(L('echo $((2<<4)) && echo ok', RM));
});

test('heredoc bodies are skipped to their terminator, whatever the terminator looks like', () => {
  const forms = [
    ['single quoted', "<<'EOF'", 'EOF'],
    ['double quoted', '<<"EOF"', 'EOF'],
    ['backslash', '<<\\EOF', 'EOF'],
    ['partly quoted', '<<E"O"F', 'EOF'],
    ['hyphenated', "<<'END-OF-DOC'", 'END-OF-DOC'],
    ['unquoted', '<<EOF', 'EOF'],
    ['with a space', "<< 'EOF'", 'EOF'],
  ];
  for (const [name, op, term] of forms) {
    notDestroy(L(`cat > /tmp/x ${op}`, RM, term), `${name}: the body is data`);
    isDestroy(L(`cat > /tmp/x ${op}`, 'body', term, RM), `${name}: the command after the terminator is classified`);
  }
  // <<- strips leading TABs from the body and the terminator
  notDestroy(L("cat > /tmp/x <<-'EOF'", '\t' + RM, '\tEOF'), '<<- body is data');
  isDestroy(L("cat > /tmp/x <<-'EOF'", '\tbody', '\tEOF', RM), '<<- TAB-indented terminator ends the body');
  // inside $( )
  notDestroy(L('git commit -m "$(cat <<\'EOF\'', RM, 'EOF', ')"'), 'commit message heredoc is data');
  isDestroy(L('git commit -m "$(cat <<\'EOF\'', 'msg', 'EOF', ')"', RM), 'command after a $( ) heredoc');
  notDestroy(L('x=$(cat <<EOF', 'msg', 'EOF)', 'echo done'), 'bash-5.2 style terminator before the paren');
  isDestroy(L('x=$(cat <<EOF', 'msg', 'EOF)', RM), 'bash-5.2 style, then a command');
  // an empty delimiter ends at an empty line
  // (review r2: the body must really end at an empty line; `rm\n` + end of input is an unterminated heredoc, now a problem)
  notDestroy(L("cat <<''", RM, '', ''), "<<'' body is data");
  isDestroy(L("cat <<''", 'body', '', RM), "<<'' ends at the empty line");
  // An unterminated heredoc still swallows the rest as bash does, but since review r2 it is a problem (the safety net
  // against any delimiter misparse): the caller fails closed, so the rest is read as commands too and rm is destroy.
  isDestroy(L("cat <<'EOF'", RM), 'unterminated: uncertain, so the rest counts as commands');
  assert.strictEqual(tp.classifyCommand(L("cat <<'EOF'", RM), o).uncertain, true);
  assert.strictEqual(c(L("cat > /tmp/x <<'EOF'", 'body', RM)), 'destroy', 'unterminated, the rest read as commands');
  assert.strictEqual(c(L("cat > /tmp/x <<'EOF'", 'body')), 'write_inside', 'unterminated, nothing dangerous in the rest');
});

test('a body is code only when a shell runs it', () => {
  isDestroy(L("bash <<'EOF'", RM, 'EOF'), 'bash');
  isDestroy(L("/bin/bash <<'EOF'", RM, 'EOF'), 'by basename');
  isDestroy(L("sh <<'EOF'", RM, 'EOF'), 'sh');
  isDestroy(L("zsh <<'EOF'", RM, 'EOF'), 'zsh');
  isDestroy(L("cat <<'EOF' | sh", RM, 'EOF'), 'piped into sh');
  isDestroy(L("cat <<'EOF' |", RM, 'EOF', 'sh'), 'pipe continued after the body');
  isDestroy(L("( cat <<'EOF'", RM, 'EOF', ') | bash'), 'subshell piped to bash');
  isDestroy(L('eval "$(cat <<\'EOF\'', RM, 'EOF', ')"'), 'eval of a substitution');
  isDestroy(L("source /dev/stdin <<'EOF'", RM, 'EOF'), 'source');
  // nested shell-fed bodies recurse to depth 3
  isDestroy(L("bash <<'L1'", "bash <<'L2'", RM, 'L2', 'L1'), 'two levels');
  isDestroy(L("bash <<'L1'", "bash <<'L2'", "bash <<'L3'", RM, 'L3', 'L2', 'L1'), 'three levels');
  // data for other programs, and files that merely contain a script
  assert.strictEqual(cr(L("python3 - <<'EOF'", 'import os  # rm -rf ~/projects', 'EOF')), 'read');
  assert.strictEqual(c(L("cat > /tmp/clean.txt <<'EOF'", RM, 'EOF')), 'write_inside');
  assert.strictEqual(c(L("cat > /tmp/clean.sh <<'EOF'", '#!/bin/sh', RM, 'EOF')), 'write_inside', 'writing a script is not running it');
});

test('an unquoted heredoc runs its command substitutions; a quoted one does not', () => {
  isDestroy(L('cat > /tmp/x <<EOF', '$(rm -rf ~/projects)', 'EOF'), 'unquoted $( )');
  isDestroy(L('cat > /tmp/x <<EOF', 'text `rm -rf ~/projects` more', 'EOF'), 'unquoted backticks');
  assert.strictEqual(c(L("cat > /tmp/x <<'EOF'", '$(rm -rf ~/projects)', 'EOF')), 'write_inside', 'quoted delimiter');
  assert.strictEqual(c(L('cat > /tmp/x <<"EOF"', '$(rm -rf ~/projects)', 'EOF')), 'write_inside', 'double-quoted delimiter');
  assert.strictEqual(c(L('cat > /tmp/x <<\\EOF', '$(rm -rf ~/projects)', 'EOF')), 'write_inside', 'backslash delimiter');
  assert.strictEqual(c(L('cat > /tmp/x <<EOF', '\\$(rm -rf ~/projects)', 'EOF')), 'write_inside', 'escaped substitution is data');
  // unquoted: a trailing backslash joins the next body line before the terminator check
  isDestroy(L('cat <<EOF', 'EO\\', 'F', RM, 'EOF'), 'EO\\ + F is the terminator EOF, so rm is outside the body');
  notDestroy(L("cat <<'EOF'", 'EO\\', 'F', RM, 'EOF'), 'quoted delimiter: no joining, rm stays in the body');
});

test('splitting on &, |&, ;;, quotes and $( ) inside double quotes', () => {
  assert.strictEqual(c('cp a ~/Desktop/b & cp c /tmp/d'), 'write_outside', 'lone & separates');
  assert.strictEqual(c('sleep 1 & ' + RM), 'destroy');
  assert.strictEqual(c('cp a /tmp/b &'), 'write_inside', 'trailing & backgrounds');
  assert.strictEqual(c('echo x |& tee ~/Desktop/f'), 'write_outside', '|& pipes both streams');
  assert.strictEqual(c('case x in a) echo hi;; b) ' + RM + ';; esac'), 'destroy', ';;');
  assert.strictEqual(c('echo "$(rm -rf /tmp/build)"'), 'destroy', '$( ) inside double quotes runs');
  assert.strictEqual(cr("echo '$(rm -rf /tmp/build)'"), 'read', 'but not inside single quotes');
  assert.strictEqual(cr('echo "a && b; c | d"'), 'read', 'operators in quotes do not split');
  const r = tp.classifyCommand('if true; then sudo ls; fi', o);
  assert.strictEqual(r.sudo, true, 'sudo after a leading keyword');
  assert.ok(SEV(r.cls) >= SEV('admin'));
});

test('redirect writes: &>, &>>, >|, >&file; fd duplication and /dev/null stay reads', () => {
  assert.strictEqual(c(`echo x &> ${HOME}/Desktop/f`), 'write_outside');
  assert.strictEqual(c('echo x &> ~/Desktop/f'), 'write_outside');
  assert.strictEqual(c('echo x &>> ~/Desktop/f'), 'write_outside');
  assert.strictEqual(c('echo x >| ~/Desktop/f'), 'write_outside');
  assert.strictEqual(c(`echo x >&${HOME}/Desktop/f`), 'write_outside');
  assert.strictEqual(c('echo x &> /tmp/f'), 'write_inside');
  assert.strictEqual(cr('ls 2>&1 | head'), 'read');
  assert.strictEqual(cr('echo x > /dev/null'), 'read');
  assert.strictEqual(cr('echo x &> /dev/null'), 'read');
  assert.strictEqual(cr('ls > /dev/null 2>&1'), 'read');
});

test('fail closed: unparseable input never classifies lower than the legacy classifier', () => {
  assert.strictEqual(typeof tp.legacyClassifyCommand, 'function', 'tp.legacyClassifyCommand is exported');
  const tricky = [
    'echo "unterminated; ' + RM,
    "echo 'unterminated; " + RM,
    'echo $(' + RM,
    L('cat <<', RM),
    L('echo $((1<<', '3)) && ' + RM),
    L("cat <<'EOF'", RM),
    'echo x > ~/Desktop/f; echo "oops',
    'sudo ls; echo $(',
    L('cat <<EOF', '$(' + RM, 'EOF'),
    'echo "$(' + RM + '"',
    L("bash <<'EOF'", RM),
    'cp a ~/Desktop/b <<',
    'echo `' + RM,
    L("cat <<'EOF' >~/Desktop/f", 'body'),
    '(( x <<= 2 ; ' + RM,
    'echo ${x:-$(' + RM,
    'if true; then sudo ls',
    L('cat <<- ', RM),
    'echo \'a\'" b; ' + RM,
    L("bash <<'L1'", "bash <<'L2'", "bash <<'L3'", "bash <<'L4'", RM),
    'cat <<<' + ' "unterminated ' + RM,
    'echo x &> ~/Desktop/f "',
    L('cat <<EOF', 'EO\\', 'F', RM),
  ];
  assert.ok(tricky.length >= 15);
  for (const cmd of tricky) {
    const now = tp.classifyCommand(cmd, o).cls;
    const old = tp.legacyClassifyCommand(cmd, o).cls;
    assert.ok(SEV(now) >= SEV(old), `${JSON.stringify(cmd)}: new ${now} is below legacy ${old}`);
  }
  // the legacy classifier keeps the same options and the same flaw
  assert.strictEqual(tp.legacyClassifyCommand(L("cat > /tmp/x <<'EOF'", 'body', 'EOF', RM), o).cls, 'write_inside');
  // nesting deeper than 3 fails closed: innermost rm -rf is destroy
  isDestroy(L("bash <<'L1'", "bash <<'L2'", "bash <<'L3'", "bash <<'L4'", RM, 'L4', 'L3', 'L2', 'L1'), 'four nested levels');
});

test('old behaviour that must stay', () => {
  assert.strictEqual(cr(L("python3 - <<'EOF'", 'import re', "if x > 1: print('/class=/')", 'EOF')), 'read');
  assert.strictEqual(cr('node --test test/x.test.js 2>&1 | grep -E "^# (pass|fail)"'), 'read');
  assert.strictEqual(cr(`echo "a > b" && echo 'x > /etc/y'`), 'read');
  assert.strictEqual(c('cat a | tee ~/Desktop/out.txt'), 'write_outside');
  assert.strictEqual(c('rm -rf /tmp/build'), 'destroy');
  assert.strictEqual(c('cp report.md ~/Desktop/report.md'), 'write_outside');
  assert.strictEqual(c('echo hi > notes.txt'), 'write_inside');
  assert.strictEqual(cr('ls -la && grep -rn foo .'), 'read');
});

test('lead review additions: $[ ] arithmetic, computed programs, # after a continuation or a substitution', () => {
  isDestroy(L('echo $[1<<2]', RM, '2]'), '$[ ] is arithmetic, not a heredoc');
  isDestroy(L("cat <<'EOF' | $SHELL", RM, 'EOF'), 'a body piped into $SHELL is commands');
  isDestroy(L("cat <<'EOF' | \"$X\"", RM, 'EOF'), 'a body piped into a program named by a variable is commands');
  isDestroy('echo A\\\n#;' + RM, 'a backslash-newline does not start a comment');
  isDestroy('echo $(echo a)#;' + RM, '# after a substitution is part of the word');
  assert.strictEqual(c(L("[ -f /tmp/a ] && cat > /tmp/b <<'EOF'", RM, 'EOF')), 'write_inside', 'the test command [ is not a shell');
});

test('the report\'s false card: a working folder outside the roots (the hub root of an agent outside a sandbox)', () => {
  const o2 = { ...o, cwd: path.join(HOME, 'hub-root-standin') };
  const cmd = L('mkdir -p /tmp/a', "cat > /tmp/a/f <<'IDEA'", 'some text > here', 'IDEA');
  assert.strictEqual(tp.legacyClassifyCommand(cmd, o2).cls, 'write_outside', 'the old reading folded cat, > and <<IDEA into mkdir');
  assert.strictEqual(tp.classifyCommand(cmd, o2).cls, 'write_inside');
});

test('review r1: carriage returns, continuations in bodies, the real command word, quoted command names', () => {
  // the reviewer's reproductions
  isDestroy('cat <<EOF\r\nbody\nEOF\r\nrm -rf ~/projects\n', 'CR ends the delimiter word only with the line: EOF\\r is the terminator');
  isDestroy('printf x\r#; rm -rf ~/projects\n', 'x\\r# is one word, the # is no comment');
  isDestroy('cat <<EOF\n$\\\n(rm -rf ~/projects)\nEOF\n', 'backslash-newline joined before the substitution is read');
  isDestroy('0<<\'EOF\' "$BASH"\nrm -rf ~/projects\nEOF\n', 'fd-numbered heredoc into a computed shell');
  isDestroy("A=1 . /dev/stdin <<'EOF'\nrm -rf ~/projects\nEOF", 'the dot command after an assignment');
  isDestroy('cat <<${x:-a b}\nbody\n${x:-a b}\nrm -rf ~/projects', 'expansion in a delimiter fails closed');
  notDestroy(L('cat <<EOF', '\\$(rm -rf ~/projects)', 'EOF'), 'an escaped $ is still data');

  // the command word decides: shells and the dot command in every position
  for (const head of [
    "<<'EOF' . /dev/stdin", "command . /dev/stdin <<'EOF'", "builtin . /dev/stdin <<'EOF'", "2>&1 . /dev/stdin <<'EOF'",
    "env at now <<'EOF'", "timeout 5 crontab - <<'EOF'", "<<'EOF' crontab -", "<< 'EOF' bash", "csh <<'EOF'", "pwsh <<'EOF'",
  ]) isDestroy(L(head, RM, 'EOF'), head);
  // data stays data
  assert.strictEqual(c(L("[ -f /tmp/a ] && cat > /tmp/b <<'EOF'", RM, 'EOF')), 'write_inside');
  notDestroy(L('cat > "$HOME/notes" <<\'EOF\'', RM, 'EOF'), 'a variable in a redirection target is not a computed program');
  assert.strictEqual(cr(L("X=1 python3 - <<'EOF'", RM, 'EOF')), 'read');
  notDestroy(L('git commit -m "$(cat <<\'EOF\'', 'rm -rf notes', 'EOF', ')"'));

  // quoted command names run the real program
  for (const cmd of [
    "r''m -rf ~/projects", "'r'm -rf ~/projects", 'r\\m -rf ~/projects', "$'rm' -rf ~/projects", "$'\\x72m' -rf ~/projects",
    "/bin/r''m -rf ~/projects", "command r''m -rf ~/projects", '{rm,-rf,~/projects}', 'r{m,} -rf ~/projects',
    'rm r -rf ~/projects', 'rm notes.txt --force',
  ]) isDestroy(cmd);
  for (const cmd of ["su''do ls /root", "'sudo' ls /root"]) {
    const r = tp.classifyCommand(cmd, o);
    assert.strictEqual(r.cls, 'admin', cmd);
    assert.strictEqual(r.sudo, true, cmd);
  }
  isDestroy('systemct\'\'l restart some-unit');
  isDestroy("kil''l -9 1");
  assert.strictEqual(c(`m''v /tmp/a ${tp.HUB_ROOT}/workspaces/other/x`), 'admin');
  // reads and writes that must not change
  assert.strictEqual(cr("grep -n 'kill' /tmp/f"), 'read');
  assert.strictEqual(cr("echo 'rm -rf /tmp/x'"), 'read');
  assert.strictEqual(cr(L("git commit -m \"$(cat <<'EOF'", 'rm -rf notes', 'EOF', ')"')), 'read');
  assert.strictEqual(cr('"$PY" /tmp/x.py'), 'read');
  assert.strictEqual(c('rm notes.txt'), 'write_inside');
});

test('review r2: words with expansions and blanks, the dot command, redirections with a {fd} prefix', () => {
  const body = L('', RM, 'EOF');
  for (const head of ["A=$(echo x) . /dev/stdin <<'EOF'", "A[x y]=1 . /dev/stdin <<'EOF'", "{v}>/tmp/f . /dev/stdin <<'EOF'", "{v}> /tmp/f . /dev/stdin <<'EOF'",
    "A=${x:-a b} . /dev/stdin <<'EOF'", "A=`echo x y` . /dev/stdin <<'EOF'", "A=$((1 + 2)) . /dev/stdin <<'EOF'", "cat <(a b) | . /dev/stdin <<'EOF'"]) {
    isDestroy(head + body, head);
  }
  // a substitution with blanks in a redirection target is not the command word
  assert.strictEqual(c(L('cat > $(dirname "$0")/x.md <<\'EOF\'', RM, 'EOF')), 'write_inside', 'the false positive of the old split');
});

test('review r2: heredoc delimiters bash groups across blanks, and a missing terminator, fail closed', () => {
  isDestroy(L('cat <<$[a b]', 'body', '$[a b]', RM), '$[ ] in a delimiter');
  isDestroy(L('cat <<@(a b)', 'body', 'EOF', RM), 'extglob in a delimiter');
  isDestroy(L('cat <<!(a b)', 'body', 'EOF', RM), 'extglob !(');
  isDestroy(L('cat <<EOF', 'body', RM), 'no terminator at all');
  assert.strictEqual(tp.classifyCommand(L('cat <<@(a b)', 'body', 'EOF', RM), o).uncertain, true);
  assert.strictEqual(c(L('cat > /tmp/x <<EOF', 'body', 'EOF')), 'write_inside', 'a terminated one stays quiet');
});

test('review r2: the wrapper walk (dequoted words, option values, positional words) reaches the shell behind them', () => {
  const body = L('', RM, 'EOF');
  for (const head of [
    'env "-i" "$BASH"', "env -u X bash", 'env --unset X --chdir /d bash', 'env -S "a b" bash', 'timeout -s KILL 5 bash', 'timeout --signal KILL 5s bash',
    'timeout 5 bash', 'xargs -I X bash', 'xargs -n 1 -P 2 bash', 'xargs --max-args 1 bash', 'sudo -u root bash', 'sudo -g g -h h -p p bash',
    'sudo --user root --prompt p bash', 'doas -u u bash', 'nice -n 5 bash', 'ionice -c 2 -n 4 bash', 'taskset 0x3 bash', 'taskset -c 0,1 bash',
    'chroot /new bash', 'runuser -u u -g g bash', 'stdbuf -i0 -o L bash', 'exec -a name bash', 'time -f %e bash', 'flock -w 3 /tmp/l bash',
    'watch -n 2 bash', 'nsenter -t 1 bash', 'strace -o /tmp/o -e x bash', 'ltrace -o /tmp/o bash', 'fakeroot bash', 'busybox sh',
  ]) isDestroy(head + " <<'EOF'" + body, head);
  isDestroy("time -p at now <<'EOF'" + body, 'time -p goes with the keyword');
  isDestroy("time -p r''m -rf ~/projects", 'time -p then a quoted command name');
  isDestroy("! time -p r''m -rf ~/projects");
  // the sudo family stays admin or worse
  const r = tp.classifyCommand('sudo -u root r\'\'m -rf ~/projects', o);
  assert.strictEqual(r.cls, 'destroy');
  assert.strictEqual(r.sudo, true);
});

test('review r2: strings that bash runs as code are read as commands', () => {
  for (const cmd of [
    `bash -c "r''m -rf ~/projects"`, `sh -c 'r""m -rf ~/projects'`, `trap 'rm -rf ~/projects' EXIT`, `trap -- "r''m -rf ~/projects" INT`,
    `flock /tmp/l -c 'rm -rf ~/projects'`, `flock -w 3 /tmp/l --command "r''m -rf ~/projects"`, `find ~/projects -exec 'rm' -rf {} +`,
    `find ~/projects -execdir "r"m -rf {} \\;`, `find ~/projects -ok 'rm' -rf {} ';'`, `eval 'r''m' -rf ~/projects`, `eval "r''m" "-rf" ~/projects`,
    L(`bash -c "cat <<'EOF'`, 'x', 'EOF', `rm -rf ~/projects"`), `script -qc "r''m -rf ~/projects" /dev/null`, `script -c "r''m -rf ~/projects" /dev/null`,
    `script --command "r''m -rf ~/projects" /dev/null`, `env -S "r''m -rf ~/projects"`, `env --split-string="r''m -rf ~/projects"`, `watch -n 1 "r''m -rf ~/projects"`,
    `su -c "r''m -rf ~/projects" user`, `bash -lc "r''m -rf ~/projects"`, `sudo bash -c "r''m -rf ~/projects"`, `busybox sh -c "r''m -rf ~/projects"`,
    `bash -c 'bash -c "r\\"\\"m -rf ~/projects"'`,
  ]) isDestroy(cmd);
  assert.strictEqual(tp.classifyCommand(`sudo bash -c "r''m -rf ~/projects"`, o).sudo, true);
  // data stays data
  assert.strictEqual(cr("echo -c 'r\"\"m -rf ~/projects'"), 'read');
  assert.strictEqual(cr("bash script.sh -c 'r\"\"m -rf ~/projects'"), 'read');
  assert.strictEqual(cr("find ~/projects -name 'r\"\"m'"), 'read');
  assert.strictEqual(cr("trap -p"), 'read');
});

test('review r2: brace expansion with nesting, sequences and option words', () => {
  for (const cmd of [
    'r{m,{a,b}} -rf x', '{{r,}m,} -rf x', '{r..r}m -rf x', '{r..r}{m..m} -rf x', 'rm -{r,f} x', 'rm {-rf,} x', 'rm --{recursive,force} x', 'rm -r{,} x',
    'rm -{,r} ~/projects', 'r{m,m} -rf x',
  ]) isDestroy(cmd);
  assert.strictEqual(c('rm {a,b}.txt'), 'write_inside', 'no option among the expansions');
  assert.strictEqual(c('echo {1..3}'), 'read');
});

test('review r2: quoted data is not read as an option; literal assignments reach later command words', () => {
  assert.strictEqual(cr('git log --grep="reboot"'), 'read');
  assert.strictEqual(cr("git log --grep='kill'"), 'read');
  assert.strictEqual(cr('git log --grep="a b" --author=x'), 'read');
  isDestroy('rm "-rf" ~/projects');
  isDestroy("rm '--force' x");
  isDestroy('c=rm; $c -rf ~/projects');
  isDestroy('c=rm; ${c} -rf ~/projects');
  isDestroy('c=rm; "$c" -rf ~/projects');
  isDestroy('c=rm; "${c}" -rf ~/projects');
  isDestroy("c='r'\"m\"; $c -rf ~/projects");
  isDestroy('c=ls; c=rm; $c -rf ~/projects');
  isDestroy('c=bash; $c -c "r\'\'m -rf ~/projects"');
  isDestroy(L('c=rm', '$c -rf ~/projects'));
  assert.strictEqual(cr('PY=python3; "$PY" /tmp/x.py'), 'read');
  // Two assignments: bash may skip either (false && c=ls), so every value counts and the program is computed (review r3).
  assert.strictEqual(c('c=rm; c=ls; $c -la /tmp'), 'admin');
  const r = tp.classifyCommand('s=sudo; $s ls /root', o);
  assert.strictEqual(r.cls, 'admin');
  assert.strictEqual(r.sudo, true);
});

test('review r2: a NUL ends the text of one $\'...\' component', () => {
  for (const nul of ['\\0', '\\00', '\\000', '\\x0', '\\x00', '\\u0000', '\\U00000000', '\\c@']) isDestroy(`$'rm${nul}ignored' -rf ~/projects`, nul);
  isDestroy("$'r\\0x'm -rf ~/projects", 'later components are kept');
  isDestroy("$'rm\\0ignored'$'' -rf ~/projects");
});

test('review r2: rm -- ends the options; --include=rm is no rm', () => {
  assert.strictEqual(c('rm -- -rf'), 'write_inside', 'a file named -rf');
  assert.strictEqual(c('rm -- -rf /tmp/a'), 'write_inside');
  assert.strictEqual(c('rm /tmp/a -- -rf'), 'write_inside', 'after -- nothing is an option');
  notDestroy('grep --include=rm -r pat .');
  notDestroy('grep --include=rm -rn pat .');
  isDestroy('rm r -rf ~/projects');
  isDestroy('/bin/rm notes.txt --force');
  isDestroy('\\rm notes.txt -rf');
  isDestroy('rm -rf -- x');
  isDestroy('r{m,} -rf x');
});

test('review r2: unlink, shred and find -delete are destroy', () => {
  isDestroy('unlink ~/projects/notes.txt');
  isDestroy('shred -u ~/projects/notes.txt');
  isDestroy('shred x');
  isDestroy('find ~/projects -name "*.md" -delete');
  isDestroy('find . -type f -delete');
  isDestroy('/usr/bin/unlink x');
  assert.strictEqual(cr('find . -name x'), 'read');
  assert.strictEqual(cr('echo deleted; ls'), 'read');
  assert.strictEqual(cr('ls | wc -l'), 'read');
});

test('review r2: huge brace words classify in under a second each', () => {
  for (const w of ['{'.repeat(200000), '{a,'.repeat(66667), '{'.repeat(100000) + '}'.repeat(100000), '{,'.repeat(100000)]) {
    const t0 = Date.now();
    const r = tp.classifyCommand(w + ' x', o);
    assert.ok(Date.now() - t0 < 1000, `${w.slice(0, 6)}: ${Date.now() - t0} ms`);
    assert.ok(SEV(r.cls) >= 0);
  }
});

test('lead decision after r2: programs named by $( ), backticks or a glob are at least admin; a plain variable is not', () => {
  for (const cmd of ['$(echo rm) -rf ~/projects', '`echo rm` -rf ~/projects', '"$(which python3)" /tmp/x.py', '/bin/r[m] -rf ~/projects', '/usr/bin/pyth?n3 /tmp/x.py']) {
    assert.ok(SEV(c(cmd)) >= SEV('admin'), cmd);
  }
  isDestroy('c=rm; $c -rf ~/projects', 'a literal assignment in the same command is resolved');
  assert.strictEqual(cr('PY=python3; "$PY" /tmp/x.py'), 'read');
  assert.strictEqual(cr('"$PY" /tmp/x.py'), 'read', 'an unresolved variable as the program is a documented limit');
  // ordinary commands stay reads (globs as arguments, test brackets, substitutions as arguments, case patterns)
  for (const cmd of ['[ -f /tmp/a ] && echo yes', '[[ -n "$X" ]] && ls', 'ls /tmp/*.png | head', 'for f in /tmp/*.txt; do wc -l "$f"; done',
    'echo "$(date)"', 'x=$(git rev-parse HEAD); echo $x', 'git log --grep="reboot" --oneline', 'node --test /tmp/r/test/*.test.js 2>&1 | tail -3',
    L("bash <<'EOF'", 'case "$1" in', '  *.txt|b*) echo text;;', '  (x) ls;;', 'esac', 'EOF'), 'find /tmp/r -name "*.js" -exec grep -l foo {} +']) {
    assert.strictEqual(cr(cmd), 'read', cmd);
  }
  // a case arm is still a command
  isDestroy(L('case $x in', '  a) rm -rf ~/projects;;', 'esac'));
});

test('hostile nesting never throws; the checker falls back to its strictest reading', () => {
  for (const cmd of ['$[ '.repeat(20000), '${'.repeat(20000), '"$('.repeat(20000), '$(('.repeat(20000), '`'.repeat(20001)]) {
    const r = tp.classifyCommand(cmd + '\n' + RM, o);
    assert.strictEqual(r.cls, 'destroy');
  }
});

const atLeastAdmin = (cmd) => assert.ok(SEV(c(cmd)) >= SEV('admin'), `${JSON.stringify(cmd)} -> ${c(cmd)}`);

test('review r3 1: brace sequences past the safe integers classify fast, and count as a computed program', () => {
  for (const cmd of ['{9007199254740992..9007199254740992} x', '{1..9007199254740993} x', '{1..5..9007199254740993} x']) {
    const t0 = Date.now();
    atLeastAdmin(cmd);
    assert.ok(Date.now() - t0 < 1000, `${cmd}: ${Date.now() - t0} ms`);
  }
});

test('review r3 2: esac after the in-branch, a case inside a substitution', () => {
  isDestroy(`(case x in esac; ${RM})`);
  isDestroy(`case x in esac; ${RM}`);
  isDestroy(L('case x in', 'esac', RM));
  isDestroy(`case x in a) :;; esac; ${RM}`);
  // a case inside a substitution is read like the lexer reads it, so the program word after it is found
  isDestroy("A=$(case x in a) :;; esac) r''m -rf ~/projects");
  assert.strictEqual(tp.classifyCommand('case x in a) :;;', o).uncertain, true, 'an open case at the top level');
  assert.strictEqual(cr('case "$1" in a) ls;; esac'), 'read');
  isDestroy(L('case $x in', '  a) rm -rf ~/projects;;', 'esac'));
});

test('review r3 3: a program named by a variable the command assigns is at least admin; candidates are classified', () => {
  isDestroy('c=rm; false && c=ls; $c -rf ~/projects');
  isDestroy('c=rm; false && c=echo; $c -rf ~/projects');
  isDestroy('c=rm; (c=echo); $c -rf ~/projects');
  isDestroy('c=rm; c=echo | true; $c -rf ~/projects');
  isDestroy('c=rm; x=$(c=echo); $c -rf ~/projects');
  isDestroy('c=rm; if false; then c=echo; fi; $c -rf ~/projects');
  isDestroy('a=r; ${a}m -rf ~/projects');
  isDestroy('a=r; b=m; $a$b -rf ~/projects');
  isDestroy('a=r; "${a}m" -rf ~/projects');
  isDestroy('declare c=rm; $c -rf ~/projects');
  isDestroy('export c=rm; $c -rf ~/projects');
  isDestroy('readonly c=rm; $c -rf ~/projects');
  isDestroy('local c=rm; $c -rf ~/projects');
  isDestroy('c=r; c+=m; $c -rf ~/projects');
  isDestroy('c=ls; c=rm; $c -rf ~/projects');
  isDestroy('for c in rm ls; do true; done; c=rm; c=ls; $c -rf ~/projects');
  for (const cmd of ['a=rm; b=a; ${!b} -rf ~/projects', 'c=xrm; ${c:1} -rf ~/projects', 'c=RM; ${c,,} -rf ~/projects', 'c=rX; ${c/X/m} -rf ~/projects',
    'c=xrm; ${c#x} -rf ~/projects', 'c=rmx; ${c%x} -rf ~/projects', 'c=rm; ${c^} -rf ~/projects', 'c=rm; c=ls; $c -la /tmp', 'read c; $c x',
    'for c in rm ls; do $c -rf ~/projects; done', 'printf -v c rm; $c x', 'mapfile c < /tmp/f; $c x', 'getopts ab c; $c x', 'c=$(echo rm); $c x', 'c=(rm); $c x']) {
    atLeastAdmin(cmd);
  }
  // one literal assignment used as a whole word resolves to its value and is not computed
  assert.strictEqual(cr('PY=python3; "$PY" /tmp/x.py'), 'read');
  assert.strictEqual(cr('PY=python3; $PY /tmp/x.py'), 'read');
  assert.strictEqual(cr('PY=python3; "${PY}" /tmp/x.py'), 'read');
  assert.strictEqual(cr('"$PY" /tmp/x.py'), 'read', 'a variable the command does not assign stays out of scope');
  assert.strictEqual(cr('$PY /tmp/x.py'), 'read');
  // ordinary commands stay reads
  for (const cmd of ['for f in /tmp/*.txt; do wc -l "$f"; done', 'x=$(git rev-parse HEAD); echo $x', 'for i in 1 2 3; do echo $i; done', 'read -r line < /tmp/f; echo "$line"',
    'case "$1" in a) ls;; esac', 'n=3; echo $n', 'f=/tmp/a; ls "$f"; cat "${f}"']) {
    assert.strictEqual(cr(cmd), 'read', cmd);
  }
});

test('review r3 4-6: code strings of the normalized segment, aliases, here-strings to a shell', () => {
  isDestroy("b{a..a}sh -c 'r\"\"m -rf ~/projects'");
  isDestroy("ba''sh -c 'r\"\"m -rf ~/projects'");
  isDestroy("shopt -s expand_aliases; alias z='rm -rf ~/projects'; z");
  isDestroy("alias z='r\"\"m -rf ~/projects' y='ls'");
  isDestroy('bash <<< "r\'\'m -rf ~/projects"');
  isDestroy('bash <<<"r\'\'m -rf ~/projects"');
  isDestroy("sh <<<'rm -rf ~/projects'");
  assert.strictEqual(cr("alias ll='ls -la'"), 'read');
  assert.strictEqual(cr('bash <<< "ls /tmp"'), 'read');
  assert.strictEqual(cr('cat <<< "rm -rf ~/projects"'), 'read', 'only a shell runs the string');
});

test('review r3 7: rm takes any unambiguous prefix of --recursive and --force', () => {
  for (const f of ['--r', '--re', '--rec', '--recu', '--recur', '--recurs', '--recursi', '--recursiv', '--recursive', '--f', '--fo', '--for', '--forc', '--force']) {
    isDestroy(`rm ${f} ~/projects`, f);
    isDestroy(`rm ~/projects ${f}`, `${f} after the operand`);
  }
  notDestroy('rm --one-file-system ~/projects/x');
  notDestroy('rm --verbose ~/projects/x');
  notDestroy('rm --dir ~/projects/x');
  notDestroy('rm --fo2 ~/projects/x');
  notDestroy('rm -- --r');
});

test('review r3 8: an arithmetic command is read; a computed program next to it is still admin', () => {
  assert.strictEqual(cr('((n*2))'), 'read');
  assert.strictEqual(cr('((a?b:c))'), 'read');
  assert.strictEqual(cr('n=3; ((n*2)); echo done'), 'read');
  atLeastAdmin('((n*2)); $(echo rm) x');
});

test('review r3 9: a chain of wrappers is bounded; a 200 KB chain classifies in under 2 s', () => {
  const t0 = Date.now();
  const r = tp.classifyCommand('flock x '.repeat(25000), o);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  assert.strictEqual(r.uncertain, true, 'too many wrappers fails closed');
  assert.ok(SEV(r.cls) >= 0);
  isDestroy(L('flock x '.repeat(40) + 'ls', RM));
  const t1 = Date.now();
  tp.classifyCommand('c=rm; $c x; '.repeat(3000), o);
  assert.ok(Date.now() - t1 < 5000, `${Date.now() - t1} ms`);
});

test('lead, review r3: a one-line command the lexer cannot read is also read as bash runs it (quotes removed)', () => {
  const r = tp.classifyCommand("echo ${x ; foo) r''m -rf ~/projects", o);
  assert.strictEqual(r.uncertain, true);
  assert.strictEqual(r.cls, 'destroy');
});

test('review r4: the single-literal exemption holds only for a plain command; positional, indirect and shadowed programs', () => {
  const H = os.homedir() + '/projects';
  // at least admin (destroy where a value is known)
  for (const cmd of [
    `IFS=,; c=rm,-rf,${H}; $c`, `IFS=:; c=rm:-rf:${H}; $c`, `: \${c:=rm}; $c -rf ~/projects`, `c=echo; unset c; : \${c:=rm}; $c -rf ~/projects`,
    `c=echo; declare -n r=c; r=rm; $c -rf ~/projects`, `c=echo; . /dev/stdin <<<'c=rm'; $c -rf ~/projects`,
    'set -- rm; $1 -rf ~/projects', 'f(){ $1 -rf ~/projects; }; f rm', 'hash -p /bin/rm x; x -rf ~/projects',
    "shopt -s expand_aliases; BASH_ALIASES[z]='rm -rf ~/projects'; z", 'ls(){ command rm "$@"; }; ls -rf ~/projects',
    "eval 'c=rm'; $c -rf ~/projects", "c='/bin/r[m]'; $c -rf ~/projects", 'c=rm; eval "$c -rf ~/projects"', "c=rm; eval '$c -rf ~/projects'",
    "export c=rm; bash -c '$c -rf ~/projects'", 'c=rm; find ~/projects -exec $c -rf {} +', L('c=rm', 'bash <<EOF', '$c -rf ~/projects', 'EOF'),
  ]) assert.ok(SEV(c(cmd)) >= SEV('admin'), cmd);
  isDestroy("eval 'c=rm'; $c -rf ~/projects", 'the value from the code string is tried once it is known');
  isDestroy('c=rm; eval "$c -rf ~/projects"', 'and inside the code string');
  isDestroy("shopt -s expand_aliases; BASH_ALIASES[z]='rm -rf ~/projects'; z", 'a BASH_ALIASES value is code');
  // the plain command keeps its exemption; values as arguments are untouched
  assert.strictEqual(cr('PY=python3; "$PY" /tmp/x.py'), 'read');
  assert.strictEqual(cr('D=/tmp/r; ls $D'), 'read');
  assert.strictEqual(cr('for i in 1 2 3; do echo $i; done'), 'read');
  assert.strictEqual(cr('while read -r line; do echo "$line"; done < /tmp/f'), 'read');
  // $c$c$c... is not expanded (memory), it is computed
  const big = 'c=' + 'x'.repeat(4000) + '; ' + '$c'.repeat(30000);
  const t = Date.now();
  assert.ok(SEV(c(big)) >= SEV('admin'));
  assert.ok(Date.now() - t < 3000, 'bounded');
});

test('review r5: here-strings anywhere, . fed a here-string, ${c[0]:=}, printf -vNAME, $_, a total substitution budget', () => {
  isDestroy("<<<'rm -rf ~/projects' bash", 'a here-string before the program');
  isDestroy(". /dev/stdin <<<'c=rm'; $c -rf ~/projects", 'a here-string sourced by . assigns c');
  for (const cmd of [': ${c[0]:=rm}; $c -rf ~/projects', "printf -vc '%s' rm; $c -rf ~/projects", ': rm; $_ -rf ~/projects']) {
    assert.ok(SEV(c(cmd)) >= SEV('admin'), cmd);
  }
  // an arithmetic command is no program (its `>2` still reads as a redirect, as before this change: below admin)
  assert.ok(SEV(c('(($1>2)) && echo big')) < SEV('admin'));
  // 5000 segments of 16 references to a 4000-char value: bounded memory and time, and never lower than admin
  const big = 'c=' + 'x'.repeat(4000) + '; ' + Array.from({ length: 5000 }, () => '$c'.repeat(16)).join('; ');
  const t = Date.now();
  assert.ok(SEV(c(big)) >= SEV('admin'));
  assert.ok(Date.now() - t < 10000, `bounded (${Date.now() - t} ms)`);
});

test('review r6: read -a NAME assigns NAME', () => {
  for (const cmd of ['read -a c <<<rm; $c -rf ~/projects', 'read -r -a c <<<rm; $c -rf ~/projects', 'read -ra c <<<rm; $c -rf ~/projects']) {
    assert.ok(SEV(c(cmd)) >= SEV('admin'), cmd);
  }
  assert.strictEqual(cr('read -r -a parts <<<"a b"; echo "${parts[0]}"'), 'read');
});

test('real-command replay (neutralised): what ran before keeps running unless something dangerous was hidden', () => {
  const w = { name: 'haiku', category: 'worker' };
  const d = (cmd) => tp.decide({ agent: w, tool: 'Bash', input: { command: cmd }, cwd: path.join(tp.HUB_ROOT, 'workspaces', 'haiku') }).decision;
  // the suite runner with a case inside $( )
  assert.strictEqual(d(`FILES=$(for f in test/*.test.js; do case "$f" in *integration.test.js|*agent-workers.test.js) ;; *) printf '%s ' "$f";; esac; done); env -i PATH=$PATH HOME=$HOME node --test $FILES 2>&1 | tail -5`), 'allow');
  // a tool path in a variable, used as the program among other commands
  assert.strictEqual(d('C=~/.npm-global/bin/sometool; $C --version 2>&1 | head -2; ls -la $C; B=$(find /tmp/x -type f -size +10M | head -1); echo $B'), 'allow');
  // a helper function that reads stdin with python, then called with labels
  assert.strictEqual(d(`cd /tmp && K=https://api.example.com/v2; cnt() { python3 -c "\nimport sys,json\nd=json.load(sys.stdin)\nprint('$1', len(d))"; }\ncurl -s -m 20 "$K/markets" | cnt markets\ncurl -s -m 20 "$K/events" | cnt events`), 'allow');
  // a python edit by heredoc, then a test file whose name carries a machine word
  assert.strictEqual(d(L('cd /tmp/wt && python3 - <<\'EOF\'', "p='test/hub-halt.test.js'; s=open(p).read()", "open(p,'w').write(s)", 'EOF', 'env -i PATH=$PATH HOME=$HOME node --test test/hub-halt.test.js 2>&1 | tail -3')), 'allow');
  // correct catches stay caught: rm -f / rm -rf and kill hidden after a heredoc
  assert.strictEqual(d(L("cat >> notes.md <<'EOF'", 'text', 'EOF', 'rm -rf __pycache__')), 'deny');
  assert.strictEqual(d(L("cat > /tmp/p.js <<'EOF'", 'x', 'EOF', 'node /tmp/p.js & SPID=$!; sleep 1; kill $SPID')), 'deny');
  // and a function that forwards its arguments to rm is read with them
  isDestroy('ls(){ command rm "$@"; }; ls -rf ~/projects');
  isDestroy('f(){ $1 -rf ~/projects; }; f rm');
});
