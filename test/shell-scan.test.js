'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { scanCommand, segmentWords, SHELL_WORDS, commandWords, normalizeSegment, dequote, rawWords } = require('../lib/shell-scan');

const segs = (t, o) => scanCommand(t, o).segments;
const ok = (t, o) => scanCommand(t, o).ok;

test('segments: newlines, & | |& ;; and chains split; redirections do not', () => {
  assert.deepStrictEqual(segs('a\nb\n\nc'), ['a', 'b', 'c']);
  assert.deepStrictEqual(segs('a && b || c; d | e |& f & g'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.deepStrictEqual(segs('case x in a) b;; c) d;; esac').slice(-4), ['b', 'c', 'd', 'esac']);
  assert.deepStrictEqual(segs('ls 2>&1'), ['ls 2>&1']);
  assert.deepStrictEqual(segs('ls &> /tmp/f'), ['ls &> /tmp/f']);
  assert.deepStrictEqual(segs('ls &>> /tmp/f'), ['ls &>> /tmp/f']);
  assert.deepStrictEqual(segs('ls >| /tmp/f'), ['ls >| /tmp/f']);
  assert.deepStrictEqual(segs('ls >&2'), ['ls >&2']);
  assert.deepStrictEqual(segs('exec 3<> /tmp/f'), ['exec 3<> /tmp/f']);
});

test('segments: quoted separators, line continuations and escapes', () => {
  assert.deepStrictEqual(segs('echo "a; b" \'c | d\' e\\;f'), ['echo "a; b" \'c | d\' e\\;f']);
  assert.deepStrictEqual(segs('ls \\\n-la'), ['ls -la']);
});

test('comments are dropped; a heredoc inside a comment is not a heredoc', () => {
  assert.deepStrictEqual(segs('ls # rm -rf x\nwc'), ['ls', 'wc']);
  assert.deepStrictEqual(segs('# cat <<EOF\nls\nwc'), ['ls', 'wc']);
  assert.deepStrictEqual(segs('echo a#b $# \\# "# x"'), ['echo a#b $# \\# "# x"']);
  assert.deepStrictEqual(segs('echo ${#x}'), ['echo ${#x}']);
});

test('# starts a comment only where a word starts in the logical text (bash 5.2)', () => {
  // A backslash-newline joins the lines: bash runs `echo A#` and then `echo HIDDEN`.
  assert.deepStrictEqual(segs('echo A\\\n#;echo HIDDEN'), ['echo A#', 'echo HIDDEN']);
  // After a substitution the # is part of the word: bash prints a# and runs the next command.
  assert.ok(segs('echo $(echo a)#;rm -rf /tmp/x').includes('rm -rf /tmp/x'));
  // After a redirection operator a new word starts, so # is a comment there and no heredoc begins.
  assert.deepStrictEqual(segs('echo hi >#<<EOF\nrm -rf /tmp/x\nEOF'), ['echo hi >', 'rm -rf /tmp/x', 'EOF']);
  // At the start of a substitution, # is a comment.
  assert.deepStrictEqual(segs('x=$(#c\necho hi)'), ['echo hi', 'x=$(\necho hi)']);
});

test('quoted or escaped << is not a heredoc', () => {
  assert.deepStrictEqual(segs('echo "<<EOF"\nls\nEOF'), ['echo "<<EOF"', 'ls', 'EOF']);
  assert.deepStrictEqual(segs("echo '<<EOF'\nls\nEOF"), ["echo '<<EOF'", 'ls', 'EOF']);
  assert.deepStrictEqual(segs('echo \\<<EOF\nls\nEOF'), ['echo \\<<EOF', 'ls', 'EOF']);
});

test('<< as shift or here-string is not a heredoc', () => {
  assert.deepStrictEqual(segs('echo $((1<<3))\nls'), ['echo $((1<<3))', 'ls']);
  assert.deepStrictEqual(segs('(( x <<= 2 ))\nls'), ['(( x <<= 2 ))', 'ls']);
  assert.deepStrictEqual(segs('cat <<< hello\nls'), ['cat <<< hello', 'ls']);
  assert.ok(ok('echo $((1<<3))\nls'));
});

test('a heredoc body is not a segment; the next line is', () => {
  const r = scanCommand("cat > /tmp/f <<'EOF'\nrm -rf /x\nEOF\nls");
  assert.deepStrictEqual(r.segments, ["cat > /tmp/f <<'EOF'", 'ls']);
  assert.strictEqual(r.ok, true);
});

test('the hole: a command after the first heredoc is a segment of its own', () => {
  assert.deepStrictEqual(segs("mkdir -p /tmp/a\ncat > /tmp/a/f <<'IDEA'\nbody\nIDEA\nrm -rf ~/projects"),
    ['mkdir -p /tmp/a', "cat > /tmp/a/f <<'IDEA'", 'rm -rf ~/projects']);
});

test('<<- strips tabs from the terminator line', () => {
  assert.deepStrictEqual(segs('cat <<-EOF\n\tbody\n\t\tEOF\nls'), ['cat <<-EOF', 'ls']);
  // without the dash a tab-indented line is not the terminator
  assert.deepStrictEqual(segs('cat <<EOF\nbody\n\tEOF\nls'), ['cat <<EOF']);
});

test('delimiters: hyphenated, partly quoted, backslashed, empty', () => {
  assert.deepStrictEqual(segs("cat <<'END-OF-DOC'\nx\nEND-OF-DOC\nls"), ["cat <<'END-OF-DOC'", 'ls']);
  assert.deepStrictEqual(segs('cat <<E"O"F\nx\nEOF\nls'), ['cat <<E"O"F', 'ls']);
  assert.deepStrictEqual(segs('cat <<\\EOF\nx\nEOF\nls'), ['cat <<\\EOF', 'ls']);
  assert.deepStrictEqual(segs("cat <<''\nx\n\nls"), ["cat <<''", 'ls']);
  assert.deepStrictEqual(segs('cat<<EOF\nx\nEOF\nls'), ['cat<<EOF', 'ls']);
  assert.deepStrictEqual(segs('cat 2<<EOF\nx\nEOF\nls'), ['cat 2<<EOF', 'ls']);
});

test('two heredocs on one line, and one in each of two segments', () => {
  assert.deepStrictEqual(segs('cat <<A <<B\na\nA\nb\nB\nls'), ['cat <<A <<B', 'ls']);
  assert.deepStrictEqual(segs('cat <<A; cat <<B\na\nA\nb\nB\nls'), ['cat <<A', 'cat <<B', 'ls']);
});

test('an unterminated heredoc consumes the rest and is not a problem', () => {
  const r = scanCommand('cat <<EOF\nrm -rf /x\nmore');
  assert.deepStrictEqual(r.segments, ['cat <<EOF']);
  assert.strictEqual(r.ok, true);
});

test('unquoted terminator joins backslash continuations; a quoted one does not', () => {
  assert.deepStrictEqual(segs('cat <<EOF\nbody\nEO\\\nF\nls'), ['cat <<EOF', 'ls']);
  // quoted: "EO\" + "F" is body, the terminator is the later EOF line
  assert.deepStrictEqual(segs("cat <<'EOF'\nbody\nEO\\\nF\nls\nEOF\nwc"), ["cat <<'EOF'", 'wc']);
});

test('bash 5.2: a line "EOF)" ends the body inside $( ) and lexing resumes at the )', () => {
  const r = scanCommand('echo $(cat <<EOF\nx\nEOF) && ls');
  assert.strictEqual(r.ok, true);
  assert.ok(r.segments.includes('cat <<EOF'));
  assert.ok(r.segments.includes('ls'));
  assert.ok(!r.segments.some(s => /^x$/.test(s)));
});

test('git commit -m "$(cat <<EOF ... EOF)": outer git segment, inner cat segment, no message text', () => {
  const r = scanCommand("git commit -m \"$(cat <<'EOF'\nrm -rf / is only text\nEOF\n)\"");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.segments.length, 2);
  assert.ok(r.segments.some(s => s.startsWith('git commit -m "$(cat <<\'EOF\'')));
  assert.ok(r.segments.includes("cat <<'EOF'"));
  assert.ok(!r.segments.some(s => s.includes('only text')));
});

test('an unquoted body: its command substitutions run; a quoted body is data', () => {
  assert.ok(segs('cat <<EOF\nhello $(touch /x)\nEOF').includes('touch /x'));
  assert.ok(segs('cat <<EOF\nhello `touch /x`\nEOF').includes('touch /x'));
  assert.ok(segs('cat <<EOF\nhello $((1+$(touch /x)))\nEOF').includes('touch /x'));
  assert.ok(!segs('cat <<EOF\nhello \\$(touch /x)\nEOF').includes('touch /x'));
  assert.deepStrictEqual(segs("cat <<'EOF'\nhello $(touch /x)\nEOF"), ["cat <<'EOF'"]);
  assert.deepStrictEqual(segs('cat <<"EOF"\nhello $(touch /x)\nEOF'), ['cat <<"EOF"']);
});

test('a body that reaches a shell is scanned as commands', () => {
  const cases = [
    "bash <<'EOF'\nrm -rf /x\nEOF",
    "cat <<'EOF' | sh\nrm -rf /x\nEOF",
    "cat <<'EOF' |\nrm -rf /x\nEOF\nsh",
    "( cat <<'EOF'\nrm -rf /x\nEOF\n) | bash",
    "echo \"$(cat <<'EOF'\nrm -rf /x\nEOF\n)\" | sh",
    "/bin/bash -s <<EOF\nrm -rf /x\nEOF",
    "eval \"$(cat <<'EOF'\nrm -rf /x\nEOF\n)\"",
    "for f in a b; do cat <<'EOF'\nrm -rf /x\nEOF\ndone | sh",
    "sudo -u sam bash <<'EOF'\nrm -rf /x\nEOF",
    ". /dev/stdin <<'EOF'\nrm -rf /x\nEOF",
  ];
  for (const c of cases) {
    const r = scanCommand(c);
    assert.ok(r.segments.includes('rm -rf /x'), `body commands of: ${JSON.stringify(c)} -> ${JSON.stringify(r.segments)}`);
    assert.strictEqual(r.ok, true, c);
  }
});

test('a body fed to a non-shell program stays data', () => {
  assert.deepStrictEqual(segs("python3 - <<'EOF'\nimport os; os.system('rm -rf /x')\nEOF"), ["python3 - <<'EOF'"]);
  assert.deepStrictEqual(segs("cat <<'EOF' | tee /tmp/f\nrm -rf /x\nEOF"), ["cat <<'EOF'", 'tee /tmp/f']);
});

test('an unquoted shell-fed body is unescaped before it is scanned', () => {
  assert.ok(segs('bash <<EOF\n\\$(touch /x)\nEOF').includes('touch /x'));
});

test('nested shell-fed bodies: 3 deep is fine, 4 deep is a problem', () => {
  const level = (inner, d) => `bash <<'L${d}'\n${inner}\nL${d}`;
  const three = level(level(level('rm -rf /x', 3), 2), 1);
  const r3 = scanCommand(three);
  assert.strictEqual(r3.ok, true);
  assert.ok(r3.segments.includes('rm -rf /x'));
  const four = level(three, 0);
  const r4 = scanCommand(four);
  assert.strictEqual(r4.ok, false);
  assert.ok(r4.problems.some(p => /too deeply/.test(p)));
});

test('command substitutions inside double quotes and plain commands emit their commands', () => {
  const r = scanCommand('echo "$(rm -rf /tmp/x)"');
  assert.ok(r.segments.includes('rm -rf /tmp/x'));
  assert.ok(r.segments.includes('echo "$(rm -rf /tmp/x)"'));
  assert.ok(segs('echo `rm -rf /tmp/x`').includes('rm -rf /tmp/x'));
  assert.ok(segs('diff <(sort a) >(tee b)').includes('sort a'));
  assert.ok(segs('diff <(sort a) >(tee b)').includes('tee b'));
  assert.ok(segs('echo ${x:-$(touch /x)}').includes('touch /x'));
  assert.deepStrictEqual(segs("echo '$(touch /x)'"), ["echo '$(touch /x)'"]);
});

test('leading keywords are stripped from segments', () => {
  assert.ok(segs('if true; then sudo ls; fi').includes('sudo ls'));
  assert.ok(segs('while true; do rm x; done').includes('rm x'));
  assert.ok(segs('(cd a && ls)').includes('cd a'));
  assert.ok(segs('! grep x f').includes('grep x f'));
  assert.ok(segs('time make').includes('make'));
});

test('problems: unterminated quotes and expansions, missing words, arithmetic across a newline, bad case', () => {
  for (const bad of ["echo 'abc", 'echo "abc', "echo $'abc", 'echo $(ls', 'echo ${x', 'echo `ls',
    'cat <<', 'cat <<\nx', 'cat << ;', 'echo $((1+\n2))', '(( 1 +\n 2 ))', 'echo $(case x in a) ls)', 'echo $(esac)']) {
    const r = scanCommand(bad);
    assert.strictEqual(r.ok, false, bad);
    assert.ok(r.problems.length > 0, bad);
  }
});

test('well-formed constructs are ok', () => {
  for (const good of ['echo "a $(ls) `pwd` ${x:-y} $((1+2))"', 'echo $(case x in a) ls;; esac)', 'echo $(a $(b $(c)))', 'cat <<EOF\n$(date)\nEOF', 'ls\\\n -l']) {
    assert.strictEqual(ok(good), true, good);
  }
});

test('hostile input stays linear and does not throw', () => {
  const t0 = Date.now();
  for (const bad of ['$('.repeat(5000), '`'.repeat(5000), '${'.repeat(5000), '"$('.repeat(3000), '<<'.repeat(5000), "'".repeat(5001), '(('.repeat(3000), 'a\n'.repeat(20000) + '<<EOF']) {
    assert.doesNotThrow(() => scanCommand(bad));
  }
  assert.ok(Date.now() - t0 < 5000);
});

test('segmentWords and SHELL_WORDS', () => {
  assert.deepStrictEqual(segmentWords(`echo "a b" 'c d' e\\ f ba''sh`), ['echo', 'a b', 'c d', 'e f', 'bash']);
  for (const w of ['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'yash', 'posh', 'fish', 'busybox', 'eval', 'source', 'su', 'parallel']) assert.ok(SHELL_WORDS.has(w), w);
});

test('$[ ] is old-style arithmetic (bash 5.2 runs `echo $[1<<2]` and then the next line), never a heredoc', () => {
  assert.deepStrictEqual(segs('echo $[1<<2]\nrm -rf /tmp/x\n2]'), ['echo $[1<<2]', 'rm -rf /tmp/x', '2]']);
  assert.ok(ok('echo "$[1<<2]"'));
  assert.ok(!ok('echo $[1<<\n2]'));
});

test('a program computed at run time may be a shell: the bodies become commands', () => {
  for (const head of ['cat <<\'EOF\' | $SHELL', 'cat <<\'EOF\' | "$X"', 'cat <<\'EOF\' | ${SH:-sh}x', 'cat <<\'EOF\' | /bin/ba?h', 'cat <<\'EOF\' | env -i $S', 'cat <<\'EOF\' | timeout 5 `which dash`']) {
    assert.ok(segs(head + '\nrm -rf /tmp/x\nEOF').includes('rm -rf /tmp/x'), head);
  }
  // The test command [ and a variable used only as an argument are not programs computed at run time.
  assert.ok(!segs('[ -f /tmp/a ] && cat > /tmp/b <<\'EOF\'\nrm -rf /tmp/x\nEOF').includes('rm -rf /tmp/x'));
  assert.ok(!segs('cat > "$HOME/notes" <<\'EOF\'\nrm -rf /tmp/x\nEOF').includes('rm -rf /tmp/x'));
  assert.ok(!segs('X=1 python3 - <<\'EOF\'\nrm -rf /tmp/x\nEOF').includes('rm -rf /tmp/x'));
});

// ── review r1 ────────────────────────────────────────────────────────

test('review r1 A: only space and tab are blanks; CR, VT and FF belong to the word', () => {
  // the terminator is EOF\r, so the body ends there and the next line runs
  assert.deepStrictEqual(segs('cat <<EOF\r\nbody\nEOF\r\nrm -rf /tmp/x\n').slice(-1), ['rm -rf /tmp/x']);
  assert.ok(!segs('cat <<EOF\r\nbody\nEOF\r\nrm -rf /tmp/x\n').includes('body'));
  // x\r# is one word, so the # starts no comment
  assert.ok(segs('printf x\r#; rm -rf /tmp/x\n').includes('rm -rf /tmp/x'));
  assert.deepStrictEqual(rawWords('a\rb\vc\fd e\tf\ng'), ['a\rb\vc\fd', 'e', 'f', 'g']);
  assert.deepStrictEqual(segmentWords('a\rb\vc\fd e\tf\ng'), ['a\rb\vc\fd', 'e', 'f', 'g']);
  // a keyword followed by CR is not a keyword
  assert.deepStrictEqual(segs('then\rx'), ['then\rx']);
});

test('review r1 B: an unquoted body joins backslash-newline before its substitutions are read', () => {
  assert.ok(segs('cat <<EOF\n$\\\n(rm -rf /tmp/x)\nEOF\n').includes('rm -rf /tmp/x'));
  assert.ok(segs('cat <<EOF\n`rm -rf /tmp/x`\nEOF\n').includes('rm -rf /tmp/x'));
  // an escaped $ stays escaped
  assert.ok(!segs('cat <<EOF\n\\$(rm -rf /tmp/x)\nEOF\n').includes('rm -rf /tmp/x'));
  // a quoted body is data
  assert.ok(!segs('cat <<\'EOF\'\n$\\\n(rm -rf /tmp/x)\nEOF\n').includes('rm -rf /tmp/x'));
});

test('review r1 C: the command word decides whether a body is code', () => {
  const body = '\nrm -rf /tmp/x\nEOF';
  const code = (head) => segs(head + body).includes('rm -rf /tmp/x');
  for (const head of [
    "A=1 . /dev/stdin <<'EOF'", "<<'EOF' . /dev/stdin", "command . /dev/stdin <<'EOF'", "builtin . /dev/stdin <<'EOF'",
    "2>&1 . /dev/stdin <<'EOF'", "env at now <<'EOF'", "timeout 5 crontab - <<'EOF'", "<<'EOF' crontab -",
    '0<<\'EOF\' "$BASH"', "<< 'EOF' bash", "csh <<'EOF'", "pwsh <<'EOF'", "/usr/bin/tcsh <<'EOF'", "cat <<'EOF' | {a,b}",
  ]) assert.ok(code(head), head);
  for (const head of [
    "[ -f /tmp/a ] && cat > /tmp/b <<'EOF'", 'cat > "$HOME/notes" <<\'EOF\'', "X=1 python3 - <<'EOF'", "cat <<'EOF'", "cat > /tmp/f 2>&1 <<'EOF'",
  ]) assert.ok(!code(head), head);
  assert.ok(!segs('git commit -m "$(cat <<\'EOF\'\nrm -rf notes\nEOF\n)"').includes('rm -rf notes'));
  const cw = commandWords('A=1 >/tmp/f env -i X=2 "command" r\'\'m -rf');
  assert.deepStrictEqual(cw.map(w => w.word), ['env', 'command', 'rm']);
  assert.strictEqual(cw[2].raw, "r''m");
});

test('review r1 D: ${ or a backtick in a heredoc delimiter is a problem', () => {
  assert.ok(!ok('cat <<${x:-a b}\nbody\n${x:-a b}\nrm -rf /tmp/x'));
  assert.ok(!ok('cat <<`echo EOF`\nbody\nEOF'));
  assert.ok(!ok('cat <<"${x}"\nbody\n${x}\n'));
  assert.ok(ok('cat <<$x\nbody\n$x\n'));
});

test('review r1 E: normalizeSegment removes quotes from command words and expands their braces', () => {
  const n = normalizeSegment;
  assert.strictEqual(n("r''m -rf /tmp/x"), 'rm -rf /tmp/x');
  assert.strictEqual(n("'r'm -rf /tmp/x"), 'rm -rf /tmp/x');
  assert.strictEqual(n('r\\m -rf /tmp/x'), 'rm -rf /tmp/x');
  assert.strictEqual(n("$'rm' -rf /tmp/x"), 'rm -rf /tmp/x');
  assert.strictEqual(n("$'\\x72m' -rf /tmp/x"), 'rm -rf /tmp/x');
  assert.strictEqual(n("$'\\162\\u006d' -rf /tmp/x"), 'rm -rf /tmp/x');
  assert.strictEqual(n("/bin/r''m -rf /tmp/x"), '/bin/rm -rf /tmp/x');
  assert.strictEqual(n("command r''m -rf /tmp/x"), 'command rm -rf /tmp/x');
  assert.strictEqual(n("su''do ls /root"), 'sudo ls /root');
  assert.strictEqual(n("'sudo' ls /root"), 'sudo ls /root');
  assert.strictEqual(n('"r"m "-rf" x'), 'rm -rf x');
  assert.strictEqual(n('{rm,-rf,/tmp/x}'), 'rm -rf /tmp/x');
  assert.strictEqual(n('r{m,} -rf /tmp/x'), 'rm r -rf /tmp/x');
  assert.strictEqual(n('pre{a,b}post{1,2} x'), 'preapost1 preapost2 prebpost1 prebpost2 x');
  assert.strictEqual(n('A=1 >/tmp/f r\'\'m x'), "A=1 >/tmp/f rm x");
  // nested braces: dequoted text only; more than 64 results: dequoted text only
  assert.strictEqual(n('r{m,{a,b}} x'), 'r{m,{a,b}} x');
  assert.strictEqual(n("r''{m,{a,b}} x"), 'r{m,{a,b}} x');
  assert.strictEqual(n("x''{1,2}{1,2}{1,2}{1,2}{1,2}{1,2}{1,2} y"), 'x{1,2}{1,2}{1,2}{1,2}{1,2}{1,2}{1,2} y');
  // quoted data stays quoted; nothing to change returns the same text
  for (const t of ["grep -n 'kill' /tmp/f", "echo 'rm -rf x'", 'echo "a b"', 'ls -la', "echo ${x:-a,b}", "cat <<'EOF'"]) assert.strictEqual(n(t), t);
  // ANSI-C and double-quote escapes
  assert.strictEqual(dequote("$'a\\tb\\n\\cA\\'\\\\'"), 'a\tb\n\x01\'\\');
  assert.strictEqual(dequote('"a\\$b\\q\\"c"'), 'a$b\\q"c');
  assert.strictEqual(dequote('a\\\nb\\ c'), 'ab c');
  assert.strictEqual(dequote("$\"x\"'y'"), 'xy');
});
