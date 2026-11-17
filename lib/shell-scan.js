'use strict';
// A small shell lexer for the tool policy: it finds the simple commands of a shell command line (segments)
// and the heredoc bodies, modelling bash quoting closely enough that a body is never mistaken for commands
// (or commands for a body) in the cases that matter. Pure: no requires, no I/O, linear time (index-based
// recursive descent, no backtracking regexes on user text).
//
//   scanCommand(text) -> { ok, segments, problems }
//
// Segments are the raw text of each simple command (comments, line continuations and heredoc bodies removed),
// at every nesting level: $( ), <( ), >( ), backticks, also inside double quotes. An outer segment keeps the
// raw text of the substitutions it contains; the commands inside them are emitted again as segments of their own.
// Heredoc bodies are data, unless the command feeds a shell (then each body is scanned as a command) or the
// body is unquoted (then the command substitutions inside it are commands). Anything the lexer cannot model
// with confidence is reported in `problems` (ok = false); the caller then falls back to its strictest reading.

const SHELL_WORDS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'yash', 'posh', 'fish', 'busybox', 'eval', 'source', 'su', 'parallel']);
const SHELL_FIRST_WORDS = new Set(['.', 'at', 'batch', 'crontab']);
const LEAD_RE = /^(?:(?:then|do|else|elif|if|while|until|time|!|\{|\()(?=\s|$)\s*)+/;
const WORD_RE = /[^\s;&|<>()'"`$\\#]+/y;
const MAX_NEST = 64;
const MAX_PROBLEMS = 50;

function newState(s) { return { s, n: s.length, i: 0, segments: [], bodies: [], problems: [], level: 0, found: false }; }
function problem(st, msg) { if (st.problems.length < MAX_PROBLEMS && !st.problems.includes(msg)) st.problems.push(msg); }

function emitSegment(st, text) {
  let t = text.trim();
  if (!t) return;
  t = t.replace(LEAD_RE, '').trim();
  if (t) st.segments.push(t);
}

/** Shell words of a segment with quotes and backslashes removed (a quoted string stays one word). */
function segmentWords(seg) {
  const s = String(seg || ''), n = s.length;
  const out = [];
  let cur = '', has = false, i = 0;
  while (i < n) {
    const c = s[i];
    if (c === "'") { let j = s.indexOf("'", i + 1); if (j < 0) j = n; cur += s.slice(i + 1, j); has = true; i = j + 1; }
    else if (c === '"') {
      i++; has = true;
      while (i < n && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < n) { const d = s[i + 1]; if (d === '\n') { /* continuation */ } else if ('$`"\\'.includes(d)) cur += d; else cur += '\\' + d; i += 2; }
        else cur += s[i++];
      }
      i++;
    }
    else if (c === '$' && s[i + 1] === "'") {
      i += 2; has = true;
      while (i < n && s[i] !== "'") { if (s[i] === '\\') { cur += s[i + 1] || ''; i += 2; } else cur += s[i++]; }
      i++;
    }
    else if (c === '\\') { if (s[i + 1] === '\n') i += 2; else { cur += s[i + 1] || ''; has = true; i += 2; } }
    else if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f') { if (has) out.push(cur); cur = ''; has = false; i++; }
    else { cur += c; has = true; i++; }
  }
  if (has) out.push(cur);
  return out;
}

// Programs that run the next word as the command (their own options are skipped too).
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'exec', 'command', 'builtin', 'nohup', 'nice', 'time', 'timeout', 'stdbuf', 'setsid', 'xargs', 'chroot', 'unbuffer', 'ionice', 'taskset', 'runuser']);

/** Raw whitespace-separated words of a segment, quotes kept (a quoted string stays inside its word). */
function rawWords(seg) {
  const s = String(seg || ''), n = s.length, out = [];
  let cur = '', i = 0;
  while (i < n) {
    const c = s[i];
    if (c === "'" || c === '"') { const e = s.indexOf(c, i + 1); const j = e < 0 ? n : e + 1; cur += s.slice(i, j); i = j; }
    else if (c === '\\') { cur += s.slice(i, i + 2); i += 2; }
    else if (/\s/.test(c)) { if (cur) out.push(cur); cur = ''; i++; }
    else { cur += c; i++; }
  }
  if (cur) out.push(cur);
  return out;
}

/** True when the program a segment runs is computed at run time ($SHELL, "$X", $(which sh), `x`, /bin/ba?h):
 *  it may be a shell, so the command's heredoc bodies are read as commands. */
function dynamicCommand(seg) {
  const ws = rawWords(seg);
  let k = 0;
  while (k < ws.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[k])) k++;   // VAR=value prefixes
  while (k < ws.length && WRAPPERS.has(ws[k].slice(ws[k].lastIndexOf('/') + 1))) {
    k++;
    while (k < ws.length && (/^-/.test(ws[k]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[k]) || /^\d/.test(ws[k]))) k++;
  }
  const w = ws[k];
  return !!w && w !== '[' && w !== '[[' && /[$`*?[]/.test(w);
}

function isShellFed(seg) {
  const ws = segmentWords(seg);
  if (ws.length && SHELL_FIRST_WORDS.has(ws[0])) return true;
  for (const w of ws) { if (SHELL_WORDS.has(w.slice(w.lastIndexOf('/') + 1))) return true; }
  return dynamicCommand(seg);
}

// ── quoting and expansions ───────────────────────────────────────────

function lexSq(st) {
  const e = st.s.indexOf("'", st.i + 1);
  if (e < 0) { problem(st, 'unterminated single quote'); const t = st.s.slice(st.i); st.i = st.n; return t; }
  const t = st.s.slice(st.i, e + 1); st.i = e + 1; return t;
}

function lexAnsi(st) {   // at $'
  const s = st.s;
  let j = st.i + 2;
  while (j < st.n && s[j] !== "'") j += s[j] === '\\' ? 2 : 1;
  if (j >= st.n) { problem(st, "unterminated $'...' quote"); const t = s.slice(st.i); st.i = st.n; return t; }
  const t = s.slice(st.i, j + 1); st.i = j + 1; return t;
}

function lexDq(st) {   // at the opening "
  const s = st.s, n = st.n;
  let out = '"';
  st.i++;
  while (st.i < n) {
    const c = s[st.i];
    if (c === '"') { out += '"'; st.i++; return out; }
    if (c === '\\') { if (s[st.i + 1] === '\n') { st.i += 2; continue; } out += s.slice(st.i, st.i + 2); st.i += 2; continue; }
    if (c === '$') { out += lexDollar(st, true); continue; }
    if (c === '`') { out += lexBacktick(st); continue; }
    out += c; st.i++;
  }
  problem(st, 'unterminated double quote');
  return out;
}

function lexSub(st, closer) {
  st.found = true;
  const r = lexCmd(st, closer);
  return r.text + (r.closed ? closer : '');
}
function lexBacktick(st) { st.i++; return '`' + lexSub(st, '`'); }

function lexDollar(st, inDq) {   // at $
  const s = st.s, c1 = s[st.i + 1];
  if (c1 === '(') {
    if (s[st.i + 2] === '(') { st.i += 3; return '$((' + lexArith(st); }
    st.i += 2; return '$(' + lexSub(st, ')');
  }
  if (c1 === '{') { st.i += 2; return '${' + lexParam(st, inDq); }
  if (c1 === '[') { st.i += 2; return '$[' + lexBracketArith(st); }
  if (c1 === "'" && !inDq) return lexAnsi(st);
  if (c1 === '"' && !inDq) { st.i++; return '$' + lexDq(st); }
  if (c1 !== undefined && '#$!?@*-'.includes(c1)) { st.i += 2; return '$' + c1; }
  st.i++; return '$';
}

/** After `$((` or `((`: text up to and including the closing `))`. A newline before it, or the end, is a problem. */
function lexArith(st) {
  const s = st.s, n = st.n;
  let out = '', d = 2;
  while (st.i < n) {
    const c = s[st.i];
    if (c === '\n') { problem(st, 'newline inside arithmetic'); return out; }
    if (c === '(') { d++; out += c; st.i++; continue; }
    if (c === ')') {
      d--; out += c; st.i++;
      if (d === 0) { if (s[st.i - 2] !== ')') problem(st, 'ambiguous arithmetic or subshell'); return out; }
      continue;
    }
    if (c === "'") { out += lexSq(st); continue; }
    if (c === '"') { out += lexDq(st); continue; }
    if (c === '`') { out += lexBacktick(st); continue; }
    if (c === '$') { out += lexDollar(st, false); continue; }
    if (c === '\\') { if (s[st.i + 1] === '\n') { st.i += 2; continue; } out += s.slice(st.i, st.i + 2); st.i += 2; continue; }
    out += c; st.i++;
  }
  problem(st, 'unterminated arithmetic');
  return out;
}

/** After `$[` (the old arithmetic form bash 5.2 still runs; `$[1<<2]` is a shift): text up to the matching `]`. */
function lexBracketArith(st) {
  const s = st.s, n = st.n;
  let out = '', d = 1;
  while (st.i < n) {
    const c = s[st.i];
    if (c === '\n') { problem(st, 'newline inside arithmetic'); return out; }
    if (c === '[') { d++; out += c; st.i++; continue; }
    if (c === ']') { d--; out += c; st.i++; if (d === 0) return out; continue; }
    if (c === "'") { out += lexSq(st); continue; }
    if (c === '"') { out += lexDq(st); continue; }
    if (c === '`') { out += lexBacktick(st); continue; }
    if (c === '$') { out += lexDollar(st, false); continue; }
    if (c === '\\') { if (s[st.i + 1] === '\n') { st.i += 2; continue; } out += s.slice(st.i, st.i + 2); st.i += 2; continue; }
    out += c; st.i++;
  }
  problem(st, 'unterminated arithmetic');
  return out;
}

/** After `${`: text up to and including the matching `}`. */
function lexParam(st, inDq) {
  const s = st.s, n = st.n;
  let out = '', d = 1;
  while (st.i < n) {
    const c = s[st.i];
    if (c === '}') { d--; out += c; st.i++; if (d === 0) return out; continue; }
    if (c === '\\') { out += s.slice(st.i, st.i + 2); st.i += 2; continue; }
    if (c === "'" && !inDq) { out += lexSq(st); continue; }
    if (c === '"') { out += lexDq(st); continue; }
    if (c === '`') { out += lexBacktick(st); continue; }
    if (c === '$') {
      if (s[st.i + 1] === '{') { d++; out += '${'; st.i += 2; continue; }
      out += lexDollar(st, inDq); continue;
    }
    out += c; st.i++;
  }
  problem(st, 'unterminated ${');
  return out;
}

// ── heredocs ─────────────────────────────────────────────────────────

/** The delimiter word at j: quotes and backslashes removed, QUOTED when any was present. */
function parseDelimiter(st, j) {
  const s = st.s, n = st.n;
  let k = j, d = '', quoted = false, bad = false;
  while (k < n) {
    const ch = s[k];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ';' || ch === '&' || ch === '|' || ch === '<' || ch === '>' || ch === '(' || ch === ')') break;
    if (ch === '\\') {
      if (s[k + 1] === '\n') { k += 2; continue; }
      quoted = true; if (k + 1 < n) d += s[k + 1];
      k += 2; continue;
    }
    if (ch === "'") {
      quoted = true;
      const e = s.indexOf("'", k + 1);
      if (e < 0) { problem(st, 'unterminated quote in heredoc delimiter'); bad = true; k = n; break; }
      d += s.slice(k + 1, e); k = e + 1; continue;
    }
    if (ch === '"') {
      quoted = true; k++;
      while (k < n && s[k] !== '"') {
        if (s[k] === '\\' && k + 1 < n && '$`"\\\n'.includes(s[k + 1])) { if (s[k + 1] !== '\n') d += s[k + 1]; k += 2; }
        else d += s[k++];
      }
      if (k >= n) { problem(st, 'unterminated quote in heredoc delimiter'); bad = true; break; }
      k++; continue;
    }
    if (ch === '$' && s[k + 1] === "'") {
      quoted = true; k += 2;
      while (k < n && s[k] !== "'") { if (s[k] === '\\') { bad = true; k += 2; } else d += s[k++]; }
      if (k >= n) { problem(st, 'unterminated quote in heredoc delimiter'); bad = true; break; }
      if (bad) problem(st, 'escape sequence in heredoc delimiter');
      k++; continue;
    }
    if (ch === '$' && s[k + 1] === '"') { k++; continue; }
    if (ch === '$' && s[k + 1] === '(') { problem(st, 'command substitution in heredoc delimiter'); bad = true; d += ch; k++; continue; }
    d += ch; k++;
  }
  return { delim: d, quoted, end: k, empty: k === j, bad };
}

function oddBackslashes(line) {
  let c = 0;
  for (let i = line.length - 1; i >= 0 && line[i] === '\\'; i--) c++;
  return (c & 1) === 1;
}

/** Read the bodies of `pending` heredocs, starting at st.i (the first character after a newline). */
function readBodies(st, pending, closer) {
  const s = st.s, n = st.n;
  for (let k = 0; k < pending.length; k++) {
    const hd = pending[k];
    const bodyStart = st.i;
    let bodyEnd = n, found = false, resumed = false;
    while (st.i < n) {
      const lineStart = st.i;
      let e = s.indexOf('\n', lineStart); if (e < 0) e = n;
      let logical = s.slice(lineStart, e);
      let next = e < n ? e + 1 : n;
      let joined = false;
      if (!hd.quoted) {
        while (e < n && oddBackslashes(logical)) {
          let e2 = s.indexOf('\n', next); if (e2 < 0) e2 = n;
          logical = logical.slice(0, -1) + s.slice(next, e2);
          next = e2 < n ? e2 + 1 : n; e = e2; joined = true;
        }
      }
      let tabs = 0;
      if (hd.stripTabs) while (logical[tabs] === '\t') tabs++;
      const cmp = tabs ? logical.slice(tabs) : logical;
      if (cmp === hd.delim) { bodyEnd = lineStart; st.i = next; found = true; break; }
      if (closer && cmp.length > hd.delim.length && cmp.startsWith(hd.delim) && cmp[hd.delim.length] === closer) {
        bodyEnd = lineStart; found = true;
        if (joined) { problem(st, 'heredoc terminator joined with a closing parenthesis'); st.i = next; }
        else { st.i = lineStart + tabs + hd.delim.length; resumed = true; }
        break;
      }
      st.i = next;
    }
    const text = found ? s.slice(bodyStart, Math.max(bodyStart, bodyEnd - 1)) : s.slice(bodyStart, n);
    st.bodies.push({ text, quoted: hd.quoted });
    if (resumed && k < pending.length - 1) { problem(st, 'several heredocs ended by a closing parenthesis'); break; }
  }
  pending.length = 0;
}

// ── the command lexer ────────────────────────────────────────────────

function lexCmd(st, closer) {
  const s = st.s, n = st.n;
  if (st.level >= MAX_NEST) { problem(st, 'nested too deeply'); st.i = n; return { text: '', closed: false }; }
  st.level++;
  let all = '', cur = '';
  const pending = [];
  let parenDepth = 0, caseDepth = 0, atCmd = true, closed = false;
  // ws: the next character starts a new word (only there does # begin a comment). Judged on the logical text,
  // so a backslash-newline (`echo A\\` + newline + `#;cmd` is the word A# in bash) never starts a comment.
  let ws = true;
  const add = (t) => { cur += t; all += t; };
  const sep = (t) => { emitSegment(st, cur); cur = ''; all += t; atCmd = true; ws = true; };

  while (st.i < n) {
    const i = st.i, c = s[i];
    if (c === '`' && closer === '`') { st.i++; closed = true; break; }

    if (c === '\\') {
      if (s[i + 1] === '\n') { st.i += 2; continue; }
      if (i + 1 < n) add(s.slice(i, i + 2)); else add(c);
      st.i += 2; atCmd = false; ws = false; continue;
    }
    if (c === "'") { add(lexSq(st)); atCmd = false; ws = false; continue; }
    if (c === '"') { add(lexDq(st)); atCmd = false; ws = false; continue; }
    if (c === '$') { add(lexDollar(st, false)); atCmd = false; ws = false; continue; }
    if (c === '`') { add(lexBacktick(st)); atCmd = false; ws = false; continue; }

    if (c === '<') {
      const c1 = s[i + 1];
      if (c1 === '<' && s[i + 2] === '<') { add('<<<'); st.i += 3; ws = true; continue; }
      if (c1 === '<') {
        const dash = s[i + 2] === '-';
        let j = i + 2 + (dash ? 1 : 0);
        while (j < n && (s[j] === ' ' || s[j] === '\t')) j++;
        const w = parseDelimiter(st, j);
        if (w.empty && !w.quoted) { problem(st, 'heredoc operator without a delimiter word'); add(s.slice(i, j)); st.i = j; ws = true; continue; }
        add(s.slice(i, w.end));
        st.i = w.end; ws = false;
        pending.push({ delim: w.delim, stripTabs: dash, quoted: w.quoted });
        continue;
      }
      if (c1 === '(') { st.i += 2; add('<(' + lexSub(st, ')')); atCmd = false; ws = false; continue; }
      if (c1 === '&' || c1 === '>') { add(s.slice(i, i + 2)); st.i += 2; ws = true; continue; }
      add('<'); st.i++; ws = true; continue;
    }
    if (c === '>') {
      const c1 = s[i + 1];
      if (c1 === '(') { st.i += 2; add('>(' + lexSub(st, ')')); atCmd = false; ws = false; continue; }
      if (c1 === '&' || c1 === '|') { add(s.slice(i, i + 2)); st.i += 2; ws = true; continue; }
      add('>'); st.i++; ws = true; continue;
    }
    if (c === '&') {
      const c1 = s[i + 1];
      if (c1 === '&') { sep('&&'); st.i += 2; continue; }
      if (c1 === '>') { add('&>'); st.i += 2; ws = true; continue; }
      sep('&'); st.i++; continue;
    }
    if (c === '|') {
      const c1 = s[i + 1];
      if (c1 === '|') { sep('||'); st.i += 2; continue; }
      if (c1 === '&') { sep('|&'); st.i += 2; continue; }
      sep('|'); st.i++; continue;
    }
    if (c === ';') {
      if (s[i + 1] === ';' && s[i + 2] === '&') { sep(';;&'); st.i += 3; continue; }
      if (s[i + 1] === ';' || s[i + 1] === '&') { sep(s.slice(i, i + 2)); st.i += 2; continue; }
      sep(';'); st.i++; continue;
    }
    if (c === '\n') {
      st.i++;
      sep('\n');
      if (pending.length) readBodies(st, pending, closer);
      continue;
    }
    if (c === '(') {
      if (s[i + 1] === '(') { st.i += 2; add('((' + lexArith(st)); atCmd = false; ws = false; continue; }
      parenDepth++; sep('('); st.i++; continue;
    }
    if (c === ')') {
      if (parenDepth > 0) { parenDepth--; sep(')'); st.i++; continue; }
      if (caseDepth > 0) { sep(')'); st.i++; continue; }
      st.i++;
      if (closer === ')') { closed = true; break; }
      sep(')'); continue;
    }
    if (c === '#') {
      if (ws) {
        let j = i;
        while (j < n && s[j] !== '\n' && !(closer === '`' && s[j] === '`' && s[j - 1] !== '\\')) j++;
        st.i = j; continue;
      }
      add('#'); st.i++; ws = false; continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\v' || c === '\f') { add(c); st.i++; ws = true; continue; }

    // a plain word
    WORD_RE.lastIndex = i;
    const m = WORD_RE.exec(s);
    if (!m) { add(c); st.i++; atCmd = false; ws = false; continue; }   // not reachable: every other character is handled above
    const word = m[0];
    const after = s[i + word.length];
    st.i = i + word.length;
    add(word); ws = false;
    if (atCmd) {
      const standalone = after === undefined || /[\s;&|<>()]/.test(after);
      if (standalone && /^(?:then|do|else|elif|if|while|until|time|!|\{)$/.test(word)) { /* still at command position */ }
      else if (standalone && word === 'case') { caseDepth++; atCmd = false; }
      else if (standalone && word === 'esac') {
        if (caseDepth > 0) caseDepth--; else if (closer) problem(st, 'esac without case');
        atCmd = false;
      } else atCmd = false;
    }
  }

  if (closer && !closed) problem(st, 'unterminated command substitution');
  else if (closer && caseDepth > 0) problem(st, 'case without esac');
  if (closer && closed && pending.length) problem(st, 'heredoc without a body inside a substitution');
  emitSegment(st, cur);
  st.level--;
  return { text: all, closed };
}

// ── deciding the bodies ──────────────────────────────────────────────

function unescapeBody(text) { return text.replace(/\\(\n|[\\$`])/g, (m, c) => (c === '\n' ? '' : c)); }

/** The command substitutions of an unquoted heredoc body (\ escapes, quotes are not special). */
function walkSubs(text, depth, maxDepth) {
  const st2 = newState(text);
  while (st2.i < st2.n) {
    const c = text[st2.i];
    if (c === '\\') { st2.i += 2; continue; }
    if (c === '$' && text[st2.i + 1] === '(') {
      if (text[st2.i + 2] === '(') { st2.i += 3; lexArith(st2); } else { st2.i += 2; lexSub(st2, ')'); }
      continue;
    }
    if (c === '`') { st2.i++; lexSub(st2, '`'); continue; }
    st2.i++;
  }
  if (!st2.found) return { segments: [], problems: st2.problems };
  if (depth + 1 > maxDepth) return { segments: [], problems: ['heredoc bodies nested too deeply'] };
  return decide(st2, depth + 1, maxDepth);
}

function decide(st, depth, maxDepth) {
  const segments = st.segments.slice();
  const problems = st.problems.slice();
  const add = (r) => { for (const x of r.segments) segments.push(x); for (const p of r.problems) if (problems.length < MAX_PROBLEMS && !problems.includes(p)) problems.push(p); };
  if (st.bodies.length) {
    const shellFed = segments.some(isShellFed);
    for (const b of st.bodies) {
      if (shellFed) {
        if (depth + 1 > maxDepth) { if (!problems.includes('heredoc bodies nested too deeply')) problems.push('heredoc bodies nested too deeply'); continue; }
        add(scanCommand(b.quoted ? b.text : unescapeBody(b.text), { depth: depth + 1, maxDepth }));
      }
      if (!b.quoted) add(walkSubs(b.text, depth, maxDepth));
    }
  }
  return { segments, problems };
}

function scanCommand(text, { depth = 0, maxDepth = 3 } = {}) {
  const st = newState(String(text == null ? '' : text));
  lexCmd(st, null);
  const r = decide(st, depth, maxDepth);
  return { ok: r.problems.length === 0, segments: r.segments, problems: r.problems };
}

module.exports = { scanCommand, segmentWords, SHELL_WORDS };
