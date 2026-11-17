'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { scanCommand, segmentWords, SHELL_WORDS, commandWords, normalizeSegment, dequote, rawWords, braceExpandRaw, hasBraceExpansion } = require('../lib/shell-scan');

const segs = (t, o) => scanCommand(t, o).segments;
const ok = (t, o) => scanCommand(t, o).ok;

test('segments: newlines, & | |& ;; and chains split; redirections do not', () => {
  assert.deepStrictEqual(segs('a\nb\n\nc'), ['a', 'b', 'c']);
  assert.deepStrictEqual(segs('a && b || c; d | e |& f & g'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  // Case patterns (a, c) are not commands: only the header, the arms and esac are segments.
  assert.deepStrictEqual(segs('case x in a) b;; c) d;; esac'), ['case x in', 'b', 'd', 'esac']);
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

test('an unterminated heredoc consumes the rest and is a problem (review r2: the safety net against a delimiter misparse)', () => {
  // The scan still takes the rest as the body, but ok is false, so the caller fails closed.
  const r = scanCommand('cat <<EOF\nrm -rf /x\nmore');
  assert.deepStrictEqual(r.segments, ['cat <<EOF']);
  assert.strictEqual(r.ok, false);
  assert.ok(r.problems.includes('heredoc without its terminator'));
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
  // A case inside $( ) is read like the lexer reads it (patterns are not closers), after the real-command replay showed
  // the suite runner `FILES=$(for f in ...; do case "$f" in ...) ;; esac; done)` failing closed.
  for (const good of ['echo $(case x in a) ls;; esac)', 'echo "a $(ls) `pwd` ${x:-y} $((1+2))"', 'echo $(a $(b $(c)))', 'cat <<EOF\n$(date)\nEOF', 'ls\\\n -l']) {
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
  // nested braces are expanded since review r2 (bash: r{m,{a,b}} -> rm ra rb); more than 64 results: dequoted text only
  assert.strictEqual(n('r{m,{a,b}} x'), 'rm ra rb x');
  assert.strictEqual(n("r''{m,{a,b}} x"), 'rm ra rb x');
  assert.strictEqual(n("x''{1,2}{1,2}{1,2}{1,2}{1,2}{1,2}{1,2} y"), 'x{1,2}{1,2}{1,2}{1,2}{1,2}{1,2}{1,2} y');
  // quoted data stays quoted; nothing to change returns the same text
  for (const t of ["grep -n 'kill' /tmp/f", "echo 'rm -rf x'", 'echo "a b"', 'ls -la', "echo ${x:-a,b}", "cat <<'EOF'"]) assert.strictEqual(n(t), t);
  // ANSI-C and double-quote escapes
  assert.strictEqual(dequote("$'a\\tb\\n\\cA\\'\\\\'"), 'a\tb\n\x01\'\\');
  assert.strictEqual(dequote('"a\\$b\\q\\"c"'), 'a$b\\q"c');
  assert.strictEqual(dequote('a\\\nb\\ c'), 'ab c');
  assert.strictEqual(dequote("$\"x\"'y'"), 'xy');
});

// ── review r2 ────────────────────────────────────────────────────────

const progs = (seg) => commandWords(seg).map(w => w.word);

test('review r2 1: blanks inside balanced expansions and assignment subscripts do not split a word', () => {
  assert.deepStrictEqual(rawWords('A=$(echo x) . /dev/stdin'), ['A=$(echo x)', '.', '/dev/stdin']);
  assert.deepStrictEqual(rawWords('cat > $(dirname "$0")/x.md'), ['cat', '>', '$(dirname "$0")/x.md']);
  assert.deepStrictEqual(rawWords('a $((1 + 2)) ${x:-b c} $[1 + 2] `ls -l` <(a b) >(c d) e'), ['a', '$((1 + 2))', '${x:-b c}', '$[1 + 2]', '`ls -l`', '<(a b)', '>(c d)', 'e']);
  assert.deepStrictEqual(rawWords('x=$(echo ")" a) y'), ['x=$(echo ")" a)', 'y']);
  assert.deepStrictEqual(rawWords('echo "$(echo "a b")" c'), ['echo', '"$(echo "a b")"', 'c']);
  assert.deepStrictEqual(rawWords("A[x y]=1 . /dev/stdin"), ['A[x y]=1', '.', '/dev/stdin']);
  assert.deepStrictEqual(rawWords('[ -f x ]'), ['[', '-f', 'x', ']']);
  assert.deepStrictEqual(rawWords('ls[ x'), ['ls[', 'x']);      // no closing ]: nothing to join
  assert.deepStrictEqual(progs("A=$(echo x) . /dev/stdin <<'EOF'"), ['.']);
  assert.deepStrictEqual(progs("cat > $(dirname \"$0\")/x.md <<'EOF'"), ['cat']);
  assert.deepStrictEqual(progs("A[x y]=1 . /dev/stdin <<'EOF'"), ['.']);
  assert.deepStrictEqual(progs("{v}>/tmp/f . /dev/stdin <<'EOF'"), ['.']);
  assert.deepStrictEqual(progs("{v}> /tmp/f . /dev/stdin <<'EOF'"), ['.']);
  assert.ok(segs("A=$(echo x) . /dev/stdin <<'EOF'\nrm -rf /tmp/x\nEOF").includes('rm -rf /tmp/x'));
  assert.ok(segs("{v}>/tmp/f . /dev/stdin <<'EOF'\nrm -rf /tmp/x\nEOF").includes('rm -rf /tmp/x'));
  assert.ok(!segs("cat > $(dirname \"$0\")/x.md <<'EOF'\nrm -rf /tmp/x\nEOF").includes('rm -rf /tmp/x'));
});

test('review r2 2: $[ and an extglob in a heredoc delimiter, and a missing terminator, are problems', () => {
  assert.ok(!ok('cat <<$[a b]\nbody\n$[a b]\nrm -rf /tmp/x'));
  assert.ok(!ok('cat <<"$[a b]"\nbody\n'));
  for (const d of ['@', '!', '+', '*', '?']) assert.ok(!ok(`cat <<${d}(a b)\nbody\nEOF\nls`), d);
  assert.ok(ok('cat <<a@b\nbody\na@b\nls'));
  assert.ok(ok("cat <<'@(a'\nbody\n@(a\nls"));
  const r = scanCommand('cat <<EOF\nbody');
  assert.ok(r.problems.includes('heredoc without its terminator'));
  assert.deepStrictEqual(r.segments, ['cat <<EOF']);
  assert.ok(ok('cat <<EOF\nbody\nEOF'));
  // inside a substitution the segment keeps an empty heredoc, so a string made of it lexes without a problem
  assert.ok(ok('eval "$(cat <<\'EOF\'\nrm -rf /x\nEOF\n)"'));
});

test('review r2 3: the wrapper walk dequotes words and skips option values and positional words', () => {
  assert.deepStrictEqual(progs('env "-i" "$BASH"'), ['env', '$BASH']);
  assert.deepStrictEqual(progs("env '-u' X bash"), ['env', 'bash']);
  assert.deepStrictEqual(progs('env "A=1" bash'), ['env', 'bash']);
  const cases = [
    ['env -u X -C /d bash', ['env', 'bash']], ['env --unset X --chdir /d bash', ['env', 'bash']], ['env --unset=X bash', ['env', 'bash']],
    ['env -S "a b" bash', ['env', 'bash']], ['env -iu X bash', ['env', 'bash']],
    ['timeout -s KILL 5 bash', ['timeout', 'bash']], ['timeout --signal KILL 5s bash', ['timeout', 'bash']], ['timeout -k 3 5 bash', ['timeout', 'bash']],
    ['timeout 5 bash', ['timeout', 'bash']], ['timeout .5 bash', ['timeout', 'bash']], ['timeout --kill-after=3 5 bash', ['timeout', 'bash']],
    ['xargs -I X bash', ['xargs', 'bash']], ['xargs -n 1 -P 4 bash', ['xargs', 'bash']], ['xargs -n1 bash', ['xargs', 'bash']], ['xargs --max-args 1 bash', ['xargs', 'bash']],
    ['xargs -a f -d x -E e -L 2 -s 9 bash', ['xargs', 'bash']], ['xargs --arg-file f --delimiter x --max-procs 2 --replace X bash', ['xargs', 'bash']],
    ['sudo -u root bash', ['sudo', 'bash']], ['sudo -g g -h h -p p -C 3 -D d -R r -T 5 -U u bash', ['sudo', 'bash']],
    ['sudo --user root --group g --host h --prompt p --close-from 3 --chdir d --chroot r --command-timeout 5 --other-user u bash', ['sudo', 'bash']],
    ['sudo -- bash', ['sudo', 'bash']], ['sudo -E -n bash', ['sudo', 'bash']],
    ['doas -u root bash', ['doas', 'bash']], ['doas -C /etc/d bash', ['doas', 'bash']],
    ['nice -n 5 bash', ['nice', 'bash']], ['nice -5 bash', ['nice', 'bash']],
    ['ionice -c 2 -n 4 -p 9 bash', ['ionice', 'bash']],
    ['taskset 0x3 bash', ['taskset', 'bash']], ['taskset -c 0,1 bash', ['taskset', 'bash']], ['taskset -c0-3 bash', ['taskset', 'bash']],
    ['chroot /new bash', ['chroot', 'bash']], ['chroot --userspec=u:g /new bash', ['chroot', 'bash']], ['chroot --groups g /new bash', ['chroot', 'bash']],
    ['runuser -u u -g g -G G bash', ['runuser', 'bash']], ['stdbuf -i0 -o L -e0 bash', ['stdbuf', 'bash']],
    ['exec -a name bash', ['exec', 'bash']], ['time -f %e -o /tmp/t bash', ['time', 'bash']],
    ['flock -w 3 -E 9 /tmp/l bash', ['flock', 'bash']], ['flock /tmp/l bash', ['flock', 'bash']], ['flock -n 9 bash', ['flock', 'bash']],
    ['watch -n 2 -d bash', ['watch', 'bash']], ['nsenter -t 1 -m bash', ['nsenter', 'bash']],
    ['strace -o /tmp/o -e trace=x -p 1 -s 9 bash', ['strace', 'bash']], ['ltrace -o o -e e -p 1 -s 9 bash', ['ltrace', 'bash']],
    ['fakeroot bash', ['fakeroot', 'bash']], ['busybox sh', ['busybox', 'sh']],
    ['sudo nice -n 5 env -u X timeout 5 bash', ['sudo', 'nice', 'env', 'timeout', 'bash']],
  ];
  for (const [seg, want] of cases) assert.deepStrictEqual(progs(seg), want, seg);
  // the walk reaches a shell behind every one of them, so a body fed to it is commands
  for (const head of ["env -u X bash", 'env "-i" "$BASH"', 'timeout -s KILL 5 sh', 'xargs -I X bash', 'sudo -u root -g wheel bash', 'doas -u u sh',
    'nice -n 5 bash', 'ionice -c 2 bash', 'taskset 0x3 bash', 'chroot /new bash', 'runuser -u u bash', 'stdbuf -oL bash', 'exec -a n bash', 'time -f %e bash',
    'flock -w 3 /tmp/l bash', 'watch -n 2 bash', 'nsenter -t 1 bash', 'strace -o /tmp/o bash', 'fakeroot bash', 'busybox sh']) {
    assert.ok(segs(head + " <<'EOF'\nrm -rf /tmp/x\nEOF").includes('rm -rf /tmp/x'), head);
  }
  // `time -p` goes together with the keyword
  assert.deepStrictEqual(segs('time -p at now'), ['at now']);
  assert.deepStrictEqual(segs('time -p ls; ! time -p ls'), ['ls', 'ls']);
  assert.ok(segs("time -p at now <<'EOF'\nrm -rf /tmp/x\nEOF").includes('rm -rf /tmp/x'));
  assert.deepStrictEqual(segs("time -p r''m -rf x"), ["r''m -rf x"]);
});

test('review r2 4: strings that bash runs as code are scanned as commands', () => {
  const has = (t, s) => assert.ok(segs(t).includes(s), `${JSON.stringify(t)} -> ${JSON.stringify(segs(t))}`);
  has('bash -c "r\'\'m -rf ~/projects"', "r''m -rf ~/projects");
  has("sh -c 'r\"\"m -rf ~/projects'", 'r""m -rf ~/projects');
  has("bash -lc 'rm -rf /tmp/x'", 'rm -rf /tmp/x');
  has("bash --norc -o errexit -c 'rm -rf /tmp/x' name arg", 'rm -rf /tmp/x');
  has("sudo -u u bash -c 'rm -rf /tmp/x'", 'rm -rf /tmp/x');
  has("busybox sh -c 'rm -rf /tmp/x'", 'rm -rf /tmp/x');
  has("zsh -c 'rm -rf /tmp/x'", 'rm -rf /tmp/x');
  has("su -c 'rm -rf /tmp/x' user", 'rm -rf /tmp/x');
  has("su user --command='rm -rf /tmp/x'", 'rm -rf /tmp/x');
  has("trap 'rm -rf /tmp/x' EXIT", 'rm -rf /tmp/x');
  has("trap -- 'rm -rf /tmp/x' INT TERM", 'rm -rf /tmp/x');
  has("flock /tmp/l -c 'rm -rf /tmp/x'", 'rm -rf /tmp/x');
  has("flock -w 3 --command 'rm -rf /tmp/x' /tmp/l", 'rm -rf /tmp/x');
  has("script -qc 'rm -rf /tmp/x' /dev/null", 'rm -rf /tmp/x');
  has("script -c 'rm -rf /tmp/x' /dev/null", 'rm -rf /tmp/x');
  has("script --command 'rm -rf /tmp/x' /dev/null", 'rm -rf /tmp/x');
  has("eval 'r''m' -rf /tmp/x", 'rm -rf /tmp/x');
  has("eval rm -rf /tmp/x", 'rm -rf /tmp/x');
  has("env -S 'rm -rf /tmp/x'", 'rm -rf /tmp/x');
  has("env --split-string='rm -rf /tmp/x'", 'rm -rf /tmp/x');
  has("env -i -S 'rm -rf /tmp/x'", 'rm -rf /tmp/x');
  has("watch -n 1 'rm -rf /tmp/x'", 'rm -rf /tmp/x');
  has('watch rm -rf /tmp/x', 'rm -rf /tmp/x');
  has("find /tmp -exec 'rm' -rf {} +", "'rm' -rf {}");
  has("find /tmp -execdir rm -rf {} \\;", 'rm -rf {}');
  has("find /tmp -ok rm -rf {} ';'", 'rm -rf {}');
  has("find /tmp -okdir rm -rf {} +", 'rm -rf {}');
  has('bash -c "cat <<\'EOF\'\nx\nEOF\nrm -rf /tmp/x"', 'rm -rf /tmp/x');
  has("bash -c 'bash -c \"rm -rf /tmp/x\"'", 'rm -rf /tmp/x');
  // not code: a script file, data after -c in a later position, a string that is only an argument
  assert.ok(!segs("bash script.sh -c 'rm -rf /tmp/x'").includes('rm -rf /tmp/x'));
  assert.ok(!segs("echo -c 'rm -rf /tmp/x'").includes('rm -rf /tmp/x'));
  assert.ok(!segs("trap -p").some(s => /rm/.test(s)));
  assert.ok(!segs("find /tmp -name 'rm -rf x'").includes('rm -rf x'));
  assert.ok(!segs("env -S").includes(''));
  // nesting is bounded: past the depth limit the scan has a problem
  const wrap = (s) => "bash -c '" + s.replace(/'/g, "'\\''") + "'";
  const three = wrap(wrap(wrap('rm -rf /tmp/x')));
  assert.strictEqual(scanCommand(three).ok, true);
  assert.ok(scanCommand(three).segments.includes('rm -rf /tmp/x'));
  const four = wrap(three);
  assert.strictEqual(scanCommand(four).ok, false);
  assert.ok(scanCommand(four).problems.some(p => /nested too deeply/.test(p)));
  assert.strictEqual(scanCommand(four, { maxDepth: 4 }).ok, true);
  assert.ok(scanCommand(four, { maxDepth: 4 }).segments.includes('rm -rf /tmp/x'));
});

test('review r2 5a: brace expansion with nesting and sequences, bounded', () => {
  const n = normalizeSegment;
  assert.strictEqual(n('r{m,{a,b}} -rf x'), 'rm ra rb -rf x');
  assert.strictEqual(n('{{r,}m,} -rf x'), 'rm m -rf x');
  assert.strictEqual(n('{r..r}m -rf x'), 'rm -rf x');
  assert.strictEqual(n('{a..c} x'), 'a b c x');
  assert.strictEqual(n('{1..3} x'), '1 2 3 x');
  assert.strictEqual(n('{3..1} x'), '3 2 1 x');
  assert.strictEqual(n('{1..7..3} x'), '1 4 7 x');
  assert.strictEqual(n('{a..e..2} x'), 'a c e x');
  assert.strictEqual(n('{01..03} x'), '01 02 03 x');
  assert.deepStrictEqual(braceExpandRaw('{a,b}{c,d}'), ['ac', 'ad', 'bc', 'bd']);
  assert.deepStrictEqual(braceExpandRaw("{'a,b',c}"), ["'a,b'", 'c']);
  assert.deepStrictEqual(braceExpandRaw('{a}{b'), ['{a}{b']);
  assert.deepStrictEqual(braceExpandRaw('{a,{b,c}'), ['{a,b', '{a,c']);
  // bounds: over 64 results, deeper than 8 levels, a sequence over 64, malformed: left dequoted, never thrown
  assert.strictEqual(braceExpandRaw('{1..100}'), null);
  assert.strictEqual(braceExpandRaw('{1..99999999999999999999}'), null);
  assert.strictEqual(braceExpandRaw('{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}'), null);
  assert.strictEqual(braceExpandRaw('{a,'.repeat(9) + 'b' + '}'.repeat(9)), null);
  assert.ok(braceExpandRaw('{a,'.repeat(8) + 'b' + '}'.repeat(8)));
  assert.strictEqual(n("r''{1..100} x"), 'r{1..100} x');
  assert.strictEqual(n("r''{a,b} x"), 'ra rb x');
  assert.doesNotThrow(() => n('{{{{ }}}} x{,'));
  assert.doesNotThrow(() => n('{a..} {..b} {,} {}'));
});

test('review r2 5b/5c: option brace words expand; quoted data is not dequoted unless it is a bare option', () => {
  const n = normalizeSegment;
  assert.strictEqual(n('rm -{r,f} x'), 'rm -r -f x');
  assert.strictEqual(n('rm {-rf,} x'), 'rm -rf x');
  assert.strictEqual(n('rm --{recursive,force} x'), 'rm --recursive --force x');
  assert.strictEqual(n('rm -r{,} x'), 'rm -r -r x');
  assert.strictEqual(n('echo {a,b}'), 'echo {a,b}');           // no option among the expansions: unchanged
  assert.strictEqual(n('git log --grep="reboot"'), 'git log --grep="reboot"');
  assert.strictEqual(n("git log --grep='kill'"), "git log --grep='kill'");
  assert.strictEqual(n('git log "--grep=x y"'), 'git log "--grep=x y"');
  assert.strictEqual(n("echo '-n x'"), "echo '-n x'");
  assert.strictEqual(n('rm "-rf" x'), 'rm -rf x');
  assert.strictEqual(n("rm '--force' x"), 'rm --force x');
  assert.strictEqual(n("rm -r'f' x"), 'rm -rf x');
});

test('review r2 5d: literal assignments are put into later command words', () => {
  const x = (t) => segs(t);
  assert.ok(x('c=rm; $c -rf /tmp/x').includes('rm -rf /tmp/x'));
  assert.ok(x('c=rm; ${c} -rf /tmp/x').includes('rm -rf /tmp/x'));
  assert.ok(x('c=rm; "$c" -rf /tmp/x').includes('rm -rf /tmp/x'));
  assert.ok(x('c=rm; "${c}" -rf /tmp/x').includes('rm -rf /tmp/x'));
  assert.ok(x("c='r''m'; $c -rf /tmp/x").includes('rm -rf /tmp/x'));
  assert.ok(x('c=rm\n$c -rf /tmp/x').includes('rm -rf /tmp/x'));
  assert.ok(x('c=rm && $c -rf /tmp/x').includes('rm -rf /tmp/x'));
  assert.ok(x('echo $(c=rm; $c -rf /tmp/x)').includes('rm -rf /tmp/x'));
  assert.ok(x('c=ls; c=rm; $c -rf /tmp/x').includes('rm -rf /tmp/x'), 'the last assignment wins');
  // Every literal value is tried (a branch, subshell or pipeline may skip an assignment), not only the last one.
  assert.ok(x('c=rm; c=ls; $c -rf /tmp/x').includes('rm -rf /tmp/x'));
  assert.ok(x('s=sudo; $s ls /root').includes('sudo ls /root'));
  assert.ok(x('s=sudo; c=rm; $s $c -rf /tmp/x').includes('sudo rm -rf /tmp/x'));
  assert.ok(x("c='rm -rf'; $c /tmp/x").includes('rm -rf /tmp/x'), 'an unquoted expansion is split into words');
  assert.ok(x("c='rm -rf'; \"$c\" /tmp/x").includes('rm\\ \\-rf /tmp/x') || !x("c='rm -rf'; \"$c\" /tmp/x").includes('rm -rf /tmp/x'), 'a quoted one is one word');
  assert.ok(x('c=bash; $c -c "rm -rf /tmp/x"').includes('rm -rf /tmp/x'), 'then the code string is read too');
  // not substituted: a value with an expansion, an argument word, another command (c=rm $c is one command)
  assert.ok(!x('c=$(echo rm); $c -rf /tmp/x').includes('rm -rf /tmp/x'));
  assert.deepStrictEqual(x('c=rm; echo $c'), ['c=rm', 'echo $c']);
  // A prefix assignment does not reach its own command's words in bash; trying its value anyway only reads stricter (review r3).
  assert.strictEqual(x('c=rm $c -rf /tmp/x')[0], 'c=rm $c -rf /tmp/x');
  assert.deepStrictEqual(x('echo hi; $c -rf'), ['echo hi', '$c -rf']);
});

test('review r2 6: a NUL ends the decoded text of one $\'...\' component', () => {
  for (const nul of ['\\0', '\\00', '\\000', '\\x0', '\\x00', '\\u0000', '\\U00000000', '\\c@']) {
    assert.strictEqual(dequote(`$'rm${nul}ignored'`), 'rm', nul);
  }
  assert.strictEqual(dequote("$'rm\\0ignored'xyz"), 'rmxyz', 'later components are kept');
  assert.strictEqual(dequote("$'a\\0b'$'c\\0d'e"), 'ace');
  assert.strictEqual(dequote("$'r\\x6dx'"), 'rmx');
  assert.strictEqual(segmentWords("$'rm\\0ignored' -rf x")[0], 'rm');
  assert.strictEqual(normalizeSegment("$'rm\\0ignored' -rf x"), 'rm -rf x');
});

test('review r2 8: brace checks are linear', () => {
  for (const w of ['{'.repeat(200000), '{a,'.repeat(66667), '{'.repeat(100000) + '}'.repeat(100000), '{,'.repeat(100000), '}'.repeat(200000)]) {
    const t0 = Date.now();
    assert.doesNotThrow(() => { normalizeSegment(w + ' x'); scanCommand(w); });
    hasBraceExpansionTimed(w);
    assert.ok(Date.now() - t0 < 1000, `${w.slice(0, 8)}: ${Date.now() - t0} ms`);
  }
  assert.strictEqual(hasBraceExpansion('a{b,c}'), true);
  assert.strictEqual(hasBraceExpansion('a{1..3}'), true);
  assert.strictEqual(hasBraceExpansion('${x:-a,b}'), false);
  assert.strictEqual(hasBraceExpansion("'{a,b}'"), false);
  assert.strictEqual(hasBraceExpansion('{a}'), false);
  assert.strictEqual(hasBraceExpansion('{a{b,c}}'), true);
});
function hasBraceExpansionTimed(w) { return hasBraceExpansion(w); }

test('review r2: hostile new constructs stay linear and do not throw', () => {
  const t0 = Date.now();
  for (const bad of ['a[ '.repeat(20000), '$( '.repeat(20000), '"$( '.repeat(5000), '<( '.repeat(20000), '${ '.repeat(20000),
    'env '.repeat(20000) + 'ls', 'eval x; '.repeat(5000), 'bash -c x; '.repeat(3000), 'find . -exec x {} ; '.repeat(3000), 'c=rm; $c x; '.repeat(3000)]) {
    assert.doesNotThrow(() => scanCommand(bad));
  }
  assert.ok(Date.now() - t0 < 10000, `${Date.now() - t0} ms`);
});

// ── review r3 ────────────────────────────────────────────────────────
const { computedProgram, codeStrings, assignmentSegments } = require('../lib/shell-scan');
const computedIn = (text) => { const r = scanCommand(text); return r.segments.some(s => computedProgram(s, r.assigned)); };

test('review r3 1: brace sequences past the safe integers do not hang', () => {
  for (const w of ['{9007199254740992..9007199254740992}', '{1..9007199254740993}', '{9007199254740991..9007199254740995}', '{1..5..9007199254740993}', '{1..' + '9'.repeat(40) + '}']) {
    const t0 = Date.now();
    assert.strictEqual(braceExpandRaw(w), null, w);
    assert.ok(computedIn(w + ' x'), `${w}: computed`);
    assert.ok(Date.now() - t0 < 1000, `${w}: ${Date.now() - t0} ms`);
  }
  assert.deepStrictEqual(braceExpandRaw('{1..3}'), ['1', '2', '3']);
  assert.strictEqual(braceExpandRaw('{1..65}'), null, 'past 64 results');
  assert.strictEqual(braceExpandRaw('{1..64}').length, 64);
});

test('review r3 2a: esac ends a case whatever the command position, and an open case is a problem at the top too', () => {
  assert.ok(segs('(case x in esac; rm -rf ~/projects)').includes('rm -rf ~/projects'));
  assert.ok(segs('case x in esac; rm -rf ~/projects').includes('rm -rf ~/projects'));
  assert.ok(segs('case x in a) :;; esac; rm -rf ~/projects').includes('rm -rf ~/projects'));
  assert.deepStrictEqual(segs('case x in a) b;; c) d;; esac'), ['case x in', 'b', 'd', 'esac']);
  assert.strictEqual(ok('case x in a) :;;'), false);
  assert.strictEqual(ok('case x in'), false);
  assert.strictEqual(ok('case "$1" in a) ls;; esac'), true);
  assert.strictEqual(ok('case x in a|esac) ls;; esac'), true, 'esac as a later alternative is a pattern');
});

test('review r3 2b: a case inside a substitution: the word splitter knows its patterns as the lexer does', () => {
  for (const t of ['A=$(case x in a) :;; esac) r\'\'m -rf ~/projects', 'echo `case x in a) :;; esac`', 'cat <(case x in a) :;; esac)', 'tee >(case x in a) :;; esac)', 'echo "$(case x in a) :;; esac)"']) {
    assert.strictEqual(scanCommand(t).ok, true, t);
  }
  assert.deepStrictEqual(rawWords("A=$(case x in a) :;; esac) r''m -rf x"), ["A=$(case x in a) :;; esac)", "r''m", '-rf', 'x']);
  assert.deepStrictEqual(rawWords('X=$(case $y in (a|b) echo 1;; *) echo 2;; esac) ls'), ['X=$(case $y in (a|b) echo 1;; *) echo 2;; esac)', 'ls']);
  assert.deepStrictEqual(rawWords('X=$(echo case x in a) ls'), ['X=$(echo case x in a)', 'ls'], 'case as an argument is no keyword');
});

test('review r3 3: assigned names, from every kind of assignment, at every level', () => {
  const names = (t) => [...scanCommand(t).assigned].sort();
  assert.deepStrictEqual(names('a=1; b+=2 c[3]=4'), ['a', 'b', 'c']);
  assert.deepStrictEqual(names('echo x y=1'), ['y'], 'a NAME= word in any position');
  assert.deepStrictEqual(names('declare -r a=1 b; export c=2 d; readonly e=3; local f=4; typeset -i g=5'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.deepStrictEqual(names('for f in a b; do :; done'), ['f']);
  assert.deepStrictEqual(names('read -r -p "x" a b; read'), ['REPLY', 'a', 'b']);
  assert.deepStrictEqual(names('printf -v out "%s" x'), ['out']);
  assert.deepStrictEqual(names('mapfile -t lines < /tmp/f; readarray -d "" z'), ['lines', 'z']);
  assert.deepStrictEqual(names('getopts ab opt'), ['OPTARG', 'OPTIND', 'opt']);
  assert.deepStrictEqual(names('x=$(y=1; echo $y)'), ['x', 'y'], 'inside a substitution');
  assert.deepStrictEqual(names("bash -c 'q=1'"), ['q'], 'inside a code string');
  assert.deepStrictEqual(names("bash <<'EOF'\nw=1\nEOF"), ['w'], 'inside a heredoc body run by a shell');
  assert.deepStrictEqual(names('echo "$HOME"; ls /tmp'), []);
});

test('review r3 3: a program named by an assigned variable is computed, except one literal assignment used as a whole word', () => {
  // a=r; ${a}m ... : one plain assignment each, so they resolve to rm (a segment) instead of counting as computed (review r6 replay)
  for (const t of ['a=r; ${a}m -rf x', 'a=r; b=m; $a$b -rf x', 'a=r; "${a}"m -rf x']) {
    assert.strictEqual(computedIn(t), false, t);
    assert.ok(scanCommand(t).segments.some(x => rawWords(x).map(dequote).join(' ') === 'rm -rf x'), t);
  }
  for (const t of ['c=rm; false && c=ls; $c -rf x', 'c=r; c+=m; $c x', 'declare c=rm; export c=ls; $c x',
    'readonly c=rm; c=ls; $c x', 'for c in rm ls; do $c x; done', 'read c; $c x', 'printf -v c rm; $c x', 'c=$(echo rm); $c x', 'c=rm; ${c:1} x', 'c=rm; ${c,,} x', 'c=rm; ${c/x/y} x',
    'c=rm; ${c#x} x', 'c=rm; ${c%x} x', 'c=rm; ${c^} x', 'a=rm; b=a; ${!b} x', 'c=rm; c=echo | true; $c x', 'c=rm; (c=echo); $c x', 'c=rm; x=$(c=echo); $c x',
    'c=(rm); $c x', 'c[0]=rm; $c x', 'sudo $c x; c=rm; c=ls', 'c=rm; env $c x; c=ls']) {
    assert.ok(computedIn(t), t);
  }
  // declare/export/readonly are not plain NAME=literal commands, so their variables count as computed (review r4).
  for (const t of ['declare c=rm; $c x', 'export c=rm; $c x', 'readonly c=rm; $c x']) assert.ok(computedIn(t), t);
  for (const t of ['PY=python3; "$PY" /tmp/x.py', 'PY=python3; $PY /tmp/x.py', 'PY=python3; ${PY} /tmp/x.py', 'PY=python3; "${PY}" /tmp/x.py', '"$PY" /tmp/x.py', '$X y', 'echo $c; c=rm',
    'for f in /tmp/*.txt; do wc -l "$f"; done', 'x=$(git rev-parse HEAD); echo $x', 'for i in 1 2 3; do echo $i; done', 'read -r line < /tmp/f; echo "$line"', 'case "$1" in a) ls;; esac']) {
    assert.strictEqual(computedIn(t), false, t);
  }
  // used without the second argument, an assigned name list makes every use computed
  assert.strictEqual(computedProgram('$c x', ['c']), true);
  assert.strictEqual(computedProgram('$c x'), false);
});

test('review r3 3: every literal value of a program variable becomes a segment', () => {
  const has = (t, s) => assert.ok(segs(t).includes(s), `${t} -> ${s}`);
  has('c=rm; false && c=ls; $c -rf x', 'rm -rf x');
  has('c=rm; false && c=ls; $c -rf x', 'ls -rf x');
  has('a=r; ${a}m -rf x', 'rm -rf x');
  has('a=r; b=m; $a$b -rf x', 'rm -rf x');
  has('declare c=rm; $c -rf x', 'rm -rf x');
  has('export c=rm; $c -rf x', 'rm -rf x');
  has('readonly c=rm; $c -rf x', 'rm -rf x');
  has('local c=rm; $c -rf x', 'rm -rf x');
  has('c=r; c+=m; $c -rf x', 'rm -rf x');
  has('c=rm; (c=echo); $c -rf x', 'rm -rf x');
  has('c=rm; (c=echo); $c -rf x', 'echo -rf x');
  has('PY=python3; "$PY" /tmp/x.py', 'python3 /tmp/x.py');
  has('c=rm; c=ls; $c -rf x', 'rm -rf x');
  assert.ok(!segs('c=rm; echo $c').some(s => s === 'rm'), 'only command words');
  // bounds: 16 values per name, 4096 chars per value, 64 combinations per segment
  const many = Array.from({ length: 40 }, (_, i) => `c=v${i}`).join('; ');
  const got = segs(many + '; $c x').filter(s => /^v\d+ x$/.test(s));
  assert.strictEqual(got.length, 16);
  assert.strictEqual(segs('c=' + 'a'.repeat(4097) + '; $c x').filter(s => s.endsWith(' x') && s.length > 4000).length, 0);
  assert.strictEqual(segs('c=' + 'a'.repeat(4096) + '; $c x').filter(s => s.endsWith(' x') && s.length > 4000).length, 1);
  const two = Array.from({ length: 10 }, (_, i) => `a=x${i}; b=y${i}`).join('; ');
  assert.ok(segs(two + '; $a$b z').filter(s => /^x\d+y\d+ z$/.test(s)).length <= 64);
  assert.ok(assignmentSegments(['$c x'], new Map([['c', { n: 1, lits: ['rm'], nonlit: false }]])).includes('rm x'));
});

test('review r3 4: code strings are read on the segment as bash will run it', () => {
  assert.ok(segs("b{a..a}sh -c 'r\"\"m -rf ~/projects'").some(s => s.includes('rm -rf ~/projects') || s.includes('r""m -rf ~/projects')));
  assert.deepStrictEqual(codeStrings("b{a..a}sh -c 'x'"), []);
  const r = scanCommand("b{a..a}sh -c 'r\"\"m -rf ~/projects'");
  assert.ok(r.segments.includes('r""m -rf ~/projects'));
  // dedupe: the same string from both readings is scanned once
  assert.strictEqual(scanCommand("bash -c 'echo hi'").segments.filter(s => s === 'echo hi').length, 1);
  assert.strictEqual(scanCommand("ba''sh -c 'echo hi'").segments.filter(s => s === 'echo hi').length, 1);
});

test('review r3 5: an alias value is a code string', () => {
  assert.deepStrictEqual(codeStrings("alias z='rm -rf ~/projects'"), ['rm -rf ~/projects']);
  assert.deepStrictEqual(codeStrings("alias a='ls' b=\"echo hi\""), ['ls', 'echo hi']);
  assert.deepStrictEqual(codeStrings('alias -p'), []);
  assert.ok(segs("shopt -s expand_aliases; alias z='rm -rf ~/projects'; z").includes('rm -rf ~/projects'));
});

test('review r3 6: a here-string to a shell is a code string', () => {
  assert.deepStrictEqual(codeStrings('bash <<< "r\'\'m -rf ~/projects"'), ["r''m -rf ~/projects"]);
  assert.deepStrictEqual(codeStrings('sh <<<"rm -rf x"'), ['rm -rf x']);
  assert.deepStrictEqual(codeStrings("zsh <<<'ls'"), ['ls']);
  assert.deepStrictEqual(codeStrings('cat <<< "rm -rf x"'), [], 'only a shell runs it');
  assert.ok(segs("bash <<< \"r''m -rf ~/projects\"").includes("r''m -rf ~/projects"));
});

test('review r3 8: an arithmetic command is not a computed program', () => {
  for (const t of ['((n*2))', '((a?b:c))', '(( n * 2 ))', 'echo hi; ((i++))']) assert.strictEqual(computedIn(t), false, t);
  assert.strictEqual(computedIn('((n*2)); $(echo rm) x'), true);
  assert.strictEqual(computedIn('((a=$(echo 1)))'), true, 'a substitution still runs');
});

test('review r3 9: a chain of wrappers is bounded and reported', () => {
  const problems = [];
  const chain = 'flock x '.repeat(40) + 'ls';
  codeStrings(chain, problems);
  assert.deepStrictEqual(problems, ['too many wrappers']);
  const few = [];
  codeStrings('flock x '.repeat(10) + 'ls', few);
  assert.deepStrictEqual(few, []);
  const t0 = Date.now();
  const big = scanCommand('flock x '.repeat(25000));
  assert.strictEqual(big.ok, false);
  assert.ok(big.problems.includes('too many wrappers'));
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
});

test('review r8 1: function calls are expanded iteratively, before the variables are resolved, from simple bodies only', () => {
  const has = (t, text) => scanCommand(t).segments.some(x => rawWords(x).map(dequote).join(' ') === text);
  const funcsOf = (t) => scanCommand(t).assigned.info.funcs;
  assert.ok(has('g(){ command rm "$@"; }; f(){ g "$@"; }; f -rf ~/projects', 'command rm -rf ~/projects'), 'a call inside an expanded body');
  assert.ok(has('h(){ command rm "$@"; }; g(){ h "$@"; }; f(){ g "$@"; }; f -rf ~/projects', 'command rm -rf ~/projects'), 'three levels');
  const deep = scanCommand('i(){ command rm "$@"; }; h(){ i "$@"; }; g(){ h "$@"; }; f(){ g "$@"; }; f -rf ~/projects');
  assert.ok(deep.problems.includes('functions nested too deeply'), JSON.stringify(deep.problems));
  assert.ok(has('a=rm; ls(){ $a "$@"; }; ls -rf ~/projects', 'rm -rf ~/projects'), 'the variable in the expanded text resolves');
  // only a simple body is read: anything else makes the function computed
  for (const t of ['f(){ command rm "${@:2}"; }; f x -rf ~/projects', 'f(){ set -- -rf ~/projects; command rm "$@"; }; f', 'f(){ shift; command rm "$@"; }; f x -rf ~/projects',
    'f(){ sh\'\'ift; command rm "$@"; }; f x', 'f(){ echo ${1:-x} $#; }; f', 'f(){ echo ${10}; }; f', 'f(){ echo $0; }; f', 'f(){ echo ' + '$1 '.repeat(257) + '; }; f x']) {
    assert.strictEqual(funcsOf(t).get('f'), null, t);
    assert.strictEqual(computedIn(t), true, t);
  }
  for (const t of ['f(){ echo "$1" $2 "${3}" "$@" $* ${@} "${*}"; }; f a b c', 'function f() { echo hi; }; f', 'function f { echo hi; }; f', 'f(){ echo "${#x}"; }; f']) {
    assert.strictEqual(typeof funcsOf(t).get('f'), 'string', t);
    assert.strictEqual(scanCommand(t).ok, true, t);
  }
  assert.strictEqual(typeof funcsOf('1x(){ command rm "$@"; }; 1x -rf ~/projects').get('1x'), 'string', 'a name that starts with a digit');
  assert.ok(has('1x(){ command rm "$@"; }; 1x -rf ~/projects', 'command rm -rf ~/projects'));
  assert.ok(has('function f() { command rm "$@"; }; f -rf ~/projects', 'command rm -rf ~/projects'), '`function f()` is one definition');
  // a } that is an argument does not end the body; one at command position does
  assert.ok(has('f(){ echo }; command rm "$@"; }; f -rf ~/projects', 'command rm -rf ~/projects'));
  assert.ok(has('f(){ { echo; }; command rm "$@"; }; f -rf ~/projects', 'command rm -rf ~/projects'));
  assert.ok(has('f(){ echo "}" \'}\' $(echo }) ${x:-}} # }\n command rm "$@"; }; f -rf ~/projects', 'command rm -rf ~/projects'));
  assert.ok(has('f(){ case "$1" in }) echo };; esac; command rm "$@"; }; f -rf ~/projects', 'command rm -rf ~/projects'));
  assert.strictEqual(funcsOf('f(){ cat <<EOF\n}\nEOF\n}; f').get('f'), null, 'a heredoc in the body: not reliable');
  assert.strictEqual(funcsOf('f(){ echo hi').get('f'), null, 'no closer: computed');
  assert.strictEqual(funcsOf('f(){ :; }; f(){ :; }; f').get('f'), null, 'defined twice');
  assert.strictEqual(scanCommand('f(){ echo "$1"; }; f hello').ok, true);
});

test('review r8 2: [[ x =~ y ]] assigns BASH_REMATCH', () => {
  assert.ok(scanCommand('[[ rm =~ rm ]]; $BASH_REMATCH -rf ~/projects').assigned.includes('BASH_REMATCH'));
  assert.strictEqual(computedIn('[[ rm =~ rm ]]; $BASH_REMATCH -rf ~/projects'), true);
  assert.strictEqual(computedIn('[[ rm = rm ]]; $BASH_REMATCH -rf ~/projects'), false, 'no =~: nothing assigned');
});

test('review r8 3: $BASH and $SHELL as the program are shells for code strings and heredoc bodies', () => {
  for (const sh of ['$BASH', '${BASH}', '$SHELL', '${SHELL}', '"$BASH"', '"${SHELL}"']) {
    assert.ok(segs(`${sh} -c 'rm -rf ~/projects'`).includes('rm -rf ~/projects'), sh + ' -c');
    assert.ok(segs(`${sh} <<<'rm -rf ~/projects'`).includes('rm -rf ~/projects'), sh + ' here-string');
    assert.ok(segs(`${sh} <<'EOF'\nrm -rf ~/projects\nEOF`).includes('rm -rf ~/projects'), sh + ' heredoc');
  }
  assert.ok(!segs("$BASHX -c 'rm -rf ~/projects'").includes('rm -rf ~/projects'));
});

test('review r8 4: scanClose reads case patterns as the lexer does', () => {
  for (const t of ['A=$(case x in esac) :;; esac) $(echo rm) -rf ~/projects', 'A=$(case x in a|esac) :;; esac) $(echo rm) -rf ~/projects',
    'A=$(case x in $(echo a)) :;; esac) $(echo rm) -rf ~/projects']) {
    const ws = rawWords(t);
    assert.strictEqual(ws[0], t.slice(0, t.indexOf(' $(echo rm)')), t);
    assert.deepStrictEqual(ws.slice(1), ['$(echo rm)', '-rf', '~/projects'], t);
    assert.strictEqual(computedIn(t), true, t);
  }
  // esac in command position ends the case, also before a `)`; a pattern `esac` not at the start does not
  assert.deepStrictEqual(rawWords('A=$(case x in a) :;; esac) ls'), ['A=$(case x in a) :;; esac)', 'ls']);
  assert.deepStrictEqual(rawWords('A=$(case x in a) :;;\nesac) ls'), ['A=$(case x in a) :;;\nesac)', 'ls']);
  assert.deepStrictEqual(rawWords('A=$(case x in (a|${y}) :;; ${z}) :;; esac) ls'), ['A=$(case x in (a|${y}) :;; ${z}) :;; esac)', 'ls']);
  assert.deepStrictEqual(rawWords('A=$(case x in `echo a`) :;; esac) ls'), ['A=$(case x in `echo a`) :;; esac)', 'ls']);
});

test('review r8 5: the single-literal exemption is off for eval/source/. and computed command words, and when a candidate is too large', () => {
  const exempt = (t) => scanCommand(t).assigned.info.exemptOK;
  assert.strictEqual(exempt('c=rm; $c -rf x'), true);
  for (const t of ['c=ls; {eval,} "$(printf \'c=%s\' rm)"; $c -rf ~/projects', 'c=ls; ev\'\'al "c=rm"; $c x', 'c=ls; \\source f; $c x', 'c=ls; . f; $c x',
    'c=ls; $(echo true) x; $c x', 'c=ls; `echo true` x; $c x', 'c=ls; /bin/tru? x; $c x', 'c=ls; {true,false} x; $c x']) {
    assert.strictEqual(exempt(t), false, t);
    assert.strictEqual(computedIn(t), true, t);
  }
  assert.strictEqual(exempt('c=ls; [ -f x ] && [[ -f y ]]; (( n = 1 )); $c x'), true, 'test commands are not computed');
  const big = scanCommand('c=rm; $c -rf ~/projects ' + 'w '.repeat(35000));
  assert.strictEqual(big.assigned.info.exemptOK, false);
  assert.strictEqual(computedIn('c=rm; $c -rf ~/projects ' + 'w '.repeat(35000)), true);
});
