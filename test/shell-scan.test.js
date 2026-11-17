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
  assert.ok(!x('c=rm; c=ls; $c -rf /tmp/x').includes('rm -rf /tmp/x'));
  assert.ok(x('s=sudo; $s ls /root').includes('sudo ls /root'));
  assert.ok(x('s=sudo; c=rm; $s $c -rf /tmp/x').includes('sudo rm -rf /tmp/x'));
  assert.ok(x("c='rm -rf'; $c /tmp/x").includes('rm -rf /tmp/x'), 'an unquoted expansion is split into words');
  assert.ok(x("c='rm -rf'; \"$c\" /tmp/x").includes('rm\\ \\-rf /tmp/x') || !x("c='rm -rf'; \"$c\" /tmp/x").includes('rm -rf /tmp/x'), 'a quoted one is one word');
  assert.ok(x('c=bash; $c -c "rm -rf /tmp/x"').includes('rm -rf /tmp/x'), 'then the code string is read too');
  // not substituted: a value with an expansion, an argument word, another command (c=rm $c is one command)
  assert.ok(!x('c=$(echo rm); $c -rf /tmp/x').includes('rm -rf /tmp/x'));
  assert.deepStrictEqual(x('c=rm; echo $c'), ['c=rm', 'echo $c']);
  assert.deepStrictEqual(x('c=rm $c -rf /tmp/x'), ['c=rm $c -rf /tmp/x']);
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
