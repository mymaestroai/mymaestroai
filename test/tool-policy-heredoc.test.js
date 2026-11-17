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
  notDestroy(L("cat <<''", RM, ''), "<<'' body is data");
  isDestroy(L("cat <<''", 'body', '', RM), "<<'' ends at the empty line");
  // an unterminated heredoc swallows the rest, as bash does
  notDestroy(L("cat <<'EOF'", RM), 'unterminated: the rest is data');
  assert.strictEqual(c(L("cat > /tmp/x <<'EOF'", 'body', RM)), 'write_inside', 'unterminated, write only');
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
