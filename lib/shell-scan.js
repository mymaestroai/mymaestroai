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

const SHELL_WORDS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'yash', 'posh', 'fish', 'busybox', 'eval', 'source', 'su', 'parallel',
  'csh', 'tcsh', 'rbash', 'pwsh', 'xonsh', 'nu', 'elvish', 'osh', 'ysh', 'oil']);
const SHELL_FIRST_WORDS = new Set(['.', 'at', 'batch', 'crontab']);
// Bash's blanks are SPACE and TAB only: CR, VT and FF are ordinary word characters (so are they here).
// `time -p` is bash's time keyword with its -p option: both go.
const LEAD_RE = /^(?:(?:then|do|else|elif|if|while|until|time(?:[ \t]+-p(?=[ \t\n]|$))?|!|\{|\()(?=[ \t\n]|$)[ \t\n]*)+/;
const WORD_RE = /[^ \t\n;&|<>()'"`$\\#]+/y;
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
      has = true;
      const e = ansiEnd(s, i + 2);
      cur += ansiDecode(s.slice(i + 2, e));
      i = e + 1;
    }
    else if (c === '\\') { if (s[i + 1] === '\n') i += 2; else { cur += s[i + 1] || ''; has = true; i += 2; } }
    else if (c === ' ' || c === '\t' || c === '\n') { if (has) out.push(cur); cur = ''; has = false; i++; }
    else { cur += c; has = true; i++; }
  }
  if (has) out.push(cur);
  return out;
}

/** Index of the closing ' of an ANSI-C quote whose body starts at `from` (s.length when unterminated). */
function ansiEnd(s, from) {
  let j = from;
  while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1;
  return Math.min(j, s.length);
}

/** The body of a $'...' quote with its escapes decoded the way bash does. */
function ansiDecode(b) {
  // Bash cuts the decoded text of one $'...' component at its first NUL (\0, \000, \x0, \u0000, \c@ ...): the rest
  // of that component is dropped (later components of the same word are kept by the callers).
  const simple = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
  let out = '';
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    if (c === '\0') return out;
    if (c !== '\\' || i + 1 >= b.length) { out += c; i++; continue; }
    const d = b[i + 1];
    i += 2;
    if (Object.prototype.hasOwnProperty.call(simple, d)) { out += simple[d]; continue; }
    let m;
    if (d === 'x' && (m = /^[0-9a-fA-F]{1,2}/.exec(b.slice(i, i + 2)))) { const v = parseInt(m[0], 16); if (v === 0) return out; out += String.fromCharCode(v); i += m[0].length; continue; }
    if ((d === 'u' || d === 'U') && (m = (d === 'u' ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/).exec(b.slice(i, i + (d === 'u' ? 4 : 8))))) {
      const cp = parseInt(m[0], 16);
      if (cp === 0) return out;
      out += cp <= 0x10FFFF ? String.fromCodePoint(cp) : '\\' + d + m[0];
      i += m[0].length; continue;
    }
    if (d >= '0' && d <= '7') { m = /^[0-7]{0,2}/.exec(b.slice(i, i + 2)); const v = parseInt(d + m[0], 8) & 255; if (v === 0) return out; out += String.fromCharCode(v); i += m[0].length; continue; }
    if (d === 'c' && i < b.length) { const x = b[i]; const v = x === '?' ? 127 : x.charCodeAt(0) & 0x1f; if (v === 0) return out; out += String.fromCharCode(v); i++; continue; }
    out += '\\' + d;
  }
  return out;
}

/** Bash quote removal on one raw word: '...' literal; "..." (backslash escapes only $ ` " \ and newline);
 *  $'...' decoded; $"..." like "..."; an unquoted backslash escapes the next character, backslash-newline vanishes. */
function dequote(raw) {
  const s = String(raw), n = s.length;
  let out = '', i = 0;
  const dq = (from) => {
    let j = from;
    while (j < n && s[j] !== '"') {
      if (s[j] === '\\' && j + 1 < n) { const d = s[j + 1]; if (d === '\n') { /* removed */ } else if ('$`"\\'.includes(d)) out += d; else out += '\\' + d; j += 2; }
      else out += s[j++];
    }
    return j + 1;
  };
  while (i < n) {
    const c = s[i];
    if (c === "'") { let j = s.indexOf("'", i + 1); if (j < 0) j = n; out += s.slice(i + 1, j); i = j + 1; }
    else if (c === '"') i = dq(i + 1);
    else if (c === '$' && s[i + 1] === "'") { const e = ansiEnd(s, i + 2); out += ansiDecode(s.slice(i + 2, e)); i = e + 1; }
    else if (c === '$' && s[i + 1] === '"') i = dq(i + 2);
    else if (c === '\\') { if (s[i + 1] === '\n') i += 2; else { out += i + 1 < n ? s[i + 1] : ''; i += 2; } }
    else { out += c; i++; }
  }
  return out;
}

// Programs that run the next word as the command (their own options are skipped too).
// Per wrapper: `short` = option letters that take a value (attached or as the next word), `long` = long options that
// take a value as the next word (`--opt=value` is one word), `pos` = positional words to skip before the command.
const WRAPPER_CFG = new Map(Object.entries({
  sudo: { short: 'ughpCDRTU', long: ['user', 'group', 'host', 'prompt', 'close-from', 'chdir', 'chroot', 'command-timeout', 'other-user'] },
  doas: { short: 'uC' },
  env: { short: 'uCS', long: ['unset', 'chdir', 'split-string'] },
  exec: { short: 'a' },
  command: {}, builtin: {}, nohup: {}, setsid: {}, unbuffer: {}, fakeroot: {}, busybox: {},
  nice: { short: 'n', long: ['adjustment'] },
  time: { short: 'fo', long: ['format', 'output'] },
  timeout: { short: 'sk', long: ['signal', 'kill-after'], pos: 1 },
  stdbuf: { short: 'ioe', long: ['input', 'output', 'error'] },
  xargs: { short: 'IadELnPs', long: ['arg-file', 'delimiter', 'max-args', 'max-procs', 'replace', 'max-chars'] },
  chroot: { long: ['userspec', 'groups'], pos: 1 },
  ionice: { short: 'cnp', long: ['class', 'classdata', 'pid'] },
  taskset: { short: 'c', pos: 1 },
  runuser: { short: 'ugG', long: ['user', 'group', 'supp-group'] },
  flock: { short: 'wE', long: ['timeout', 'conflict-exit-code'], pos: 1 },
  watch: { short: 'n', long: ['interval'] },
  nsenter: { short: 't', long: ['target'] },
  strace: { short: 'oeps' }, ltrace: { short: 'oeps' },
}));

const ASSIGN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_SKIP_DEPTH = 40;

/** Index just after the closer of a construct whose body starts at `from` ($( ), ${ }, $[ ], <( ), >( )): quotes,
 *  escapes, backticks and nested openers are skipped. Unterminated: s.length, or -1 when `strict`. */
function scanClose(s, from, open, close, depth, strict) {
  const n = s.length;
  if (depth > MAX_SKIP_DEPTH) return strict ? -1 : n;
  let level = 1;
  for (let j = from; j < n;) {
    const c = s[j];
    if (c === '\\') { j += 2; continue; }
    if (c === "'") { const e = s.indexOf("'", j + 1); j = e < 0 ? n : e + 1; continue; }
    if (c === '"') { j = dqEnd(s, j + 1, depth + 1); continue; }
    if (c === '`') { j = btEnd(s, j + 1); continue; }
    if (c === '$' && s[j + 1] === "'") { j = Math.min(ansiEnd(s, j + 2) + 1, n); continue; }
    if (c === open) level++;
    else if (c === close) { level--; if (level === 0) return j + 1; }
    j++;
  }
  return strict ? -1 : n;
}

/** Index just after the closing backtick of a backtick substitution whose body starts at `from`. */
function btEnd(s, from) {
  for (let j = from; j < s.length;) {
    if (s[j] === '\\') { j += 2; continue; }
    if (s[j] === '`') return j + 1;
    j++;
  }
  return s.length;
}

/** End of the unit at i that must be skipped whole when looking for structure: an escape, a quoted string, $'..',
 *  $".." , ${ }, $( ), $[ ] or a backtick substitution; i + 1 for an ordinary character. */
function opaqueEnd(s, i) {
  const c = s[i], n = s.length;
  if (c === '\\') return Math.min(i + 2, n);
  if (c === "'") { const e = s.indexOf("'", i + 1); return e < 0 ? n : e + 1; }
  if (c === '"') return dqEnd(s, i + 1);
  if (c === '`') return btEnd(s, i + 1);
  if (c === '$') {
    const d = s[i + 1];
    if (d === "'") return Math.min(ansiEnd(s, i + 2) + 1, n);
    if (d === '"') return dqEnd(s, i + 2);
    if (d === '(') return scanClose(s, i + 2, '(', ')', 0);
    if (d === '{') return scanClose(s, i + 2, '{', '}', 0);
    if (d === '[') return scanClose(s, i + 2, '[', ']', 0);
  }
  return i + 1;
}

/** Raw whitespace-separated words of a segment, quotes kept (a quoted string stays inside its word). Blanks inside
 *  $( ), $(( )), ${ }, $[ ], backticks, <( ) and >( ), and inside the subscript of an assignment (A[x y]=1), do not split. */
function rawWords(seg) {
  const s = String(seg || ''), n = s.length, out = [];
  let cur = '', i = 0, noSub = false;
  while (i < n) {
    const c = s[i];
    let j = -1;
    if (c === "'" || c === '"' || c === '`' || c === '$') { j = opaqueEnd(s, i); if (j === i + 1) j = -1; }
    else if ((c === '<' || c === '>') && s[i + 1] === '(') j = scanClose(s, i + 2, '(', ')', 0);
    else if (c === '[' && !noSub && ASSIGN_NAME_RE.test(cur)) { j = scanClose(s, i + 1, '[', ']', 0, true); if (j < 0) noSub = true; }
    if (j >= 0) { cur += s.slice(i, j); i = j; continue; }
    if (c === '\\') { cur += s.slice(i, i + 2); i += 2; }
    else if (c === ' ' || c === '\t' || c === '\n') { if (cur) out.push(cur); cur = ''; i++; }
    else { cur += c; i++; }
  }
  if (cur) out.push(cur);
  return out;
}

/** Index just after the closing " of a double-quoted string whose body starts at `from` (backslash escapes; a
 *  $( ), ${ } or backtick inside may hold quotes of its own). */
function dqEnd(s, from, depth = 0) {
  const n = s.length;
  let j = from;
  while (j < n && s[j] !== '"') {
    const c = s[j];
    if (c === '\\') j += 2;
    else if (c === '$' && s[j + 1] === '(') j = scanClose(s, j + 2, '(', ')', depth + 1);
    else if (c === '$' && s[j + 1] === '{') j = scanClose(s, j + 2, '{', '}', depth + 1);
    else if (c === '`') j = btEnd(s, j + 1);
    else j++;
  }
  return Math.min(j + 1, n);
}

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const REDIR_OPS = '(?:<<<|<<-|<<|>>|>\\||&>>|&>|<&|>&|<>|<|>)';
const REDIR_FD = '(?:\\d+|\\{[A-Za-z_][A-Za-z0-9_]*\\})?';   // 2> or {fd}>
const REDIR_RE = new RegExp('^' + REDIR_FD + REDIR_OPS);
const REDIR_ONLY_RE = new RegExp('^' + REDIR_FD + REDIR_OPS + '$');
const basenameOf = (w) => w.slice(w.lastIndexOf('/') + 1);

/** Indexes (into rawWords) of the effective command words of a segment: the first word after assignments and
 *  redirections, and, while that is a wrapper (sudo, env, command ...), the word it runs after its own options
 *  (an option's separate value and the wrapper's positional words are skipped too). Words are dequoted before
 *  they are tested as options, assignments or numbers. */
function commandIndexes(ws) {
  const out = [];
  let k = 0, cfg = null, pos = 0, optsDone = false;
  for (;;) {
    while (k < ws.length) {
      const w = ws[k];
      if (REDIR_RE.test(w)) { k += REDIR_ONLY_RE.test(w) ? 2 : 1; continue; }
      if (!cfg) { if (ASSIGN_RE.test(w)) { k++; continue; } break; }
      const dw = dequote(w);
      if (ASSIGN_RE.test(dw)) { k++; continue; }
      if (!optsDone && dw[0] === '-') {
        if (dw === '--') { optsDone = true; k++; continue; }
        let skipNext = false;
        if (dw[1] === '-') {
          const name = dw.slice(2);
          if (!name.includes('=') && cfg.long && cfg.long.includes(name)) skipNext = true;
        } else {
          const letters = dw.slice(1);
          for (let x = 0; x < letters.length; x++) {
            if (cfg.short && cfg.short.includes(letters[x])) {
              if (x === letters.length - 1) skipNext = true;
              if (letters[x] === 'c' && cfg === WRAPPER_CFG.get('taskset')) pos = 0;
              break;
            }
          }
        }
        k += skipNext ? 2 : 1; continue;
      }
      if (pos > 0) { pos--; k++; continue; }
      if (optsDone) break;
      if (/^\d/.test(dw)) { k++; continue; }
      break;
    }
    if (k >= ws.length) break;
    out.push(k);
    cfg = WRAPPER_CFG.get(basenameOf(dequote(ws[k])));
    if (!cfg) break;
    pos = cfg.pos || 0; optsDone = false;
    k++;
  }
  return out;
}

/** The effective command words of a segment, at every level of a wrapper chain: [{ raw, word, index }]. */
function commandWords(seg) {
  const ws = rawWords(seg);
  return commandIndexes(ws).map(index => ({ raw: ws[index], word: dequote(ws[index]), index }));
}

/** True when the raw word holds an unquoted brace expansion ({a,b} or {1..3}); `${` is not one. One linear pass:
 *  a stack of the open braces, each remembering whether a `,` or `..` appeared at its own level before its `}`. */
function hasBraceExpansion(s) {
  const stack = [];
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '{') { stack.push(false); i++; }
    else if (c === '}') { if (stack.length && stack.pop()) return true; i++; }
    else if (c === ',') { if (stack.length) stack[stack.length - 1] = true; i++; }
    else if (c === '.' && s[i + 1] === '.') { if (stack.length) stack[stack.length - 1] = true; i += 2; }
    else i = opaqueEnd(s, i);
  }
  return false;
}

const BRACE_MAX = 64, BRACE_DEPTH = 8, BRACE_GROUPS = 256;

/** The matched { } groups of a raw word, from one pass: Map open index -> { close, commas } (the commas of its own level). */
function braceTable(s) {
  const stack = [], groups = new Map();
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '{') { stack.push({ at: i, commas: [] }); i++; }
    else if (c === '}') { const g = stack.pop(); if (g) groups.set(g.at, { close: i, commas: g.commas }); i++; }
    else if (c === ',') { if (stack.length) stack[stack.length - 1].commas.push(i); i++; }
    else i = opaqueEnd(s, i);
  }
  return groups;
}

/** The literal results of a sequence body (1..3, a..e, 1..10..2, 01..03): an array, null when it is no sequence, 'big' past the bound. */
function braceSequence(body) {
  let m = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(body);
  let a, b, letters = false, width = 0;
  if (m) {
    a = Number(m[1]); b = Number(m[2]);
    if (/^-?0\d/.test(m[1]) || /^-?0\d/.test(m[2])) width = Math.max(m[1].replace('-', '').length, m[2].replace('-', '').length);
  } else if ((m = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/.exec(body))) {
    a = m[1].charCodeAt(0); b = m[2].charCodeAt(0); letters = true;
  } else return null;
  const step = Math.abs(Number(m[3] || 1)) || 1;
  // Past 2^53 a number no longer changes when 1 is added (v + 1 === v): endpoints and step must be safe integers.
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(step) || Math.abs(b - a) / step >= BRACE_MAX) return 'big';
  const out = [];
  const up = a <= b;
  for (let v = a; up ? v <= b : v >= b;) {
    if (out.length >= BRACE_MAX) return 'big';
    if (letters) out.push(String.fromCharCode(v));
    else { const t = String(Math.abs(v)).padStart(width, '0'); out.push(v < 0 ? '-' + t : t); }
    const nv = v + (up ? step : -step);
    if (nv === v) return 'big';
    v = nv;
  }
  return out;
}

/** The expansions of raw[lo, hi): an array, or null past a bound (64 results, 8 levels, 256 groups). */
function braceRange(ctx, lo, hi, depth) {
  const { raw, table } = ctx;
  for (let i = lo; i < hi;) {
    if (raw[i] !== '{') { i = Math.min(opaqueEnd(raw, i), hi); continue; }
    const g = table.get(i);
    if (g && g.close < hi) {
      let alts = null;     // each: [lo, hi) of the raw text, or a literal string
      if (g.commas.length) {
        alts = [];
        let from = i + 1;
        for (const cm of g.commas) { alts.push([from, cm]); from = cm + 1; }
        alts.push([from, g.close]);
      } else {
        const seq = g.close - i > 48 ? null : braceSequence(raw.slice(i + 1, g.close));   // a sequence body is short
        if (seq === 'big') return null;
        alts = seq;
      }
      if (alts) {
        if (++ctx.count > BRACE_GROUPS || depth >= BRACE_DEPTH) return null;
        const mid = [];
        for (const alt of alts) {
          const r = typeof alt === 'string' ? [alt] : braceRange(ctx, alt[0], alt[1], depth + 1);
          if (!r) return null;
          for (const x of r) mid.push(x);
          if (mid.length > BRACE_MAX) return null;
        }
        const post = braceRange(ctx, g.close + 1, hi, depth);
        if (!post || mid.length * post.length > BRACE_MAX) return null;
        const pre = raw.slice(lo, i), out = [];
        for (const a of mid) for (const p of post) out.push(pre + a + p);
        return out;
      }
    }
    i++;
  }
  return [raw.slice(lo, hi)];
}

/** Brace expansion of a raw word (nested groups, comma lists, sequences; empty results dropped as bash drops them):
 *  the raw results, [raw] when there is none, null when it is malformed past a bound (64 results, 8 levels). */
function braceExpandRaw(raw) {
  const r = braceRange({ raw, table: braceTable(raw), count: 0 }, 0, raw.length, 0);
  return r && (r.length === 1 && r[0] === raw ? r : r.filter(x => x !== ''));
}

const FLAG_RE = /^--?[A-Za-z0-9][A-Za-z0-9-]*$/;

/** A word that is not the program: a quoted option (`"-rf"`) is dequoted, and a brace word that expands to options
 *  (`-{r,f}`, `{-rf,}`) becomes its expansions; anything else (quoted data) stays raw. */
function normalizeArgWord(w) {
  if (hasBraceExpansion(w)) {
    const ex = braceExpandRaw(w);
    if (ex && ex.some(e => dequote(e)[0] === '-')) {
      return ex.map(e => { const d = dequote(e); return FLAG_RE.test(d) ? d : e; }).join(' ');
    }
  }
  const d = dequote(w);
  return FLAG_RE.test(d) ? d : w;
}

/** Rebuild a segment the way bash will read it: each command word dequoted and brace-expanded (r''m, $'\x72m',
 *  {rm,-rf,x}), and every later word that is a quoted option (`"-rf"`) dequoted or an option brace word expanded.
 *  Other words stay raw, so quoted data stays quoted. Returns seg itself when nothing changed. */
function normalizeSegment(seg) {
  const ws = rawWords(seg);
  const idx = new Set(commandIndexes(ws));
  let changed = false;
  const out = ws.map((w, i) => {
    let r;
    if (idx.has(i)) {
      const ex = braceExpandRaw(w);
      r = ex ? ex.map(dequote).join(' ') : dequote(w);   // null: malformed or past a bound, so just the dequoted text
    } else r = normalizeArgWord(w);
    if (r !== w) changed = true;
    return r;
  });
  return changed ? out.join(' ') : seg;
}

/** True when the raw word is computed at run time: an unquoted-by-single-quotes $ or backtick, an unquoted glob
 *  character (* ? [), or an unquoted brace expansion. */
function dynamicWord(w) {
  if (w === '[' || w === '[[') return false;
  for (let i = 0; i < w.length;) {
    const c = w[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const e = w.indexOf("'", i + 1); i = e < 0 ? w.length : e + 1; continue; }
    if (c === '$' && w[i + 1] === "'") { i = Math.min(ansiEnd(w, i + 2) + 1, w.length); continue; }
    if (c === '"') {
      const e = dqEnd(w, i + 1);
      for (let j = i + 1; j < e - 1; j++) { if (w[j] === '\\') j++; else if (w[j] === '$' || w[j] === '`') return true; }
      i = e; continue;
    }
    if (c === '$' || c === '`' || c === '*' || c === '?' || c === '[') return true;
    i++;
  }
  return hasBraceExpansion(w);
}

/** True when the program a segment runs is computed at run time ($SHELL, "$X", $(which sh), `x`, /bin/ba?h, {a,b}):
 *  it may be a shell, so the command's heredoc bodies are read as commands. */
function dynamicCommand(seg) {
  const ws = rawWords(seg);
  return commandIndexes(ws).some(k => dynamicWord(ws[k]));
}

function isShellFed(seg) {
  for (const w of segmentWords(seg)) { if (SHELL_WORDS.has(basenameOf(w))) return true; }
  for (const { word } of commandWords(seg)) {
    const b = basenameOf(word);
    if (SHELL_WORDS.has(b) || SHELL_FIRST_WORDS.has(b)) return true;
  }
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
  let k = j, d = '', quoted = false, bad = false, lastPlain = -1;
  while (k < n) {
    const ch = s[k];
    // an extglob group (@(a b), !( ), +( ), *( ), ?( )) holds blanks and )s that bash keeps in the word
    if (ch === '(' && lastPlain === k - 1 && '@!+*?'.includes(s[k - 1])) { problem(st, 'extended glob in heredoc delimiter'); bad = true; }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === ';' || ch === '&' || ch === '|' || ch === '<' || ch === '>' || ch === '(' || ch === ')') break;
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
        else {
          if (s[k] === '`' || (s[k] === '$' && (s[k + 1] === '{' || s[k + 1] === '['))) { problem(st, 'expansion in heredoc delimiter'); bad = true; }
          d += s[k++];
        }
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
    if (ch === '`' || (ch === '$' && (s[k + 1] === '{' || s[k + 1] === '['))) { problem(st, 'expansion in heredoc delimiter'); bad = true; d += ch; k++; continue; }
    if (ch === '$' && s[k + 1] === '(') { problem(st, 'command substitution in heredoc delimiter'); bad = true; d += ch; k++; continue; }
    lastPlain = k; d += ch; k++;
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
    // The general safety net against any delimiter misparse: bash would end the body somewhere else. The scan still
    // takes the rest as the body; the caller fails closed on the problem.
    if (!found) problem(st, 'heredoc without its terminator');
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
  // casePhase: 1 after `case` until its `in`, 2 inside a pattern (until its `)`). A pattern is not a command: its text
  // (`*.txt|b*`) is dropped, so a glob in it never reads as a program, and its `|` and leading `(` are not operators.
  let casePhase = 0;
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
    if (c === '|' && casePhase === 2) { add('|'); st.i++; continue; }
    if (c === '|') {
      const c1 = s[i + 1];
      if (c1 === '|') { sep('||'); st.i += 2; continue; }
      if (c1 === '&') { sep('|&'); st.i += 2; continue; }
      sep('|'); st.i++; continue;
    }
    if (c === ';') {
      if (s[i + 1] === ';' && s[i + 2] === '&') { sep(';;&'); st.i += 3; if (caseDepth > 0) casePhase = 2; continue; }
      if (s[i + 1] === ';' || s[i + 1] === '&') { sep(s.slice(i, i + 2)); st.i += 2; if (caseDepth > 0) casePhase = 2; continue; }
      sep(';'); st.i++; continue;
    }
    if (c === '\n') {
      st.i++;
      sep('\n');
      if (pending.length) {
        const hds = pending.slice();
        readBodies(st, pending, closer);
        // Inside a substitution the text goes on into the outer segment without the body: keep an empty heredoc
        // (the terminator line) in it, so a string made of that text (eval "$(cat <<EOF ...)") still lexes.
        if (closer) for (const hd of hds) all += hd.delim + '\n';
      }
      continue;
    }
    if (c === '(' && casePhase === 2 && s[i + 1] !== '(') { add('('); st.i++; continue; }
    if (c === '(') {
      if (s[i + 1] === '(') { st.i += 2; add('((' + lexArith(st)); atCmd = false; ws = false; continue; }
      parenDepth++; sep('('); st.i++; continue;
    }
    if (c === ')' && casePhase === 2) { cur = ''; all += ')'; casePhase = 0; atCmd = true; ws = true; st.i++; continue; }
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
    if (c === ' ' || c === '\t') { add(c); st.i++; ws = true; continue; }

    // a plain word
    WORD_RE.lastIndex = i;
    const m = WORD_RE.exec(s);
    if (!m) { add(c); st.i++; atCmd = false; ws = false; continue; }   // not reachable: every other character is handled above
    const word = m[0];
    const after = s[i + word.length];
    st.i = i + word.length;
    const curBefore = cur;
    add(word); ws = false;
    if (casePhase === 1 && word === 'in' && (after === undefined || /[ \t\n;&|<>()]/.test(after))) { emitSegment(st, cur); cur = ''; casePhase = 2; continue; }
    // `esac` first in a pattern position ends the case whatever atCmd says (`(case x in esac; rm -rf y)`), unless it is
    // itself a pattern (`esac)`).
    if (casePhase === 2 && word === 'esac' && curBefore.trim() === '' && (after === undefined || /[ \t\n;&|<>(]/.test(after))) {
      casePhase = 0; if (caseDepth > 0) caseDepth--; atCmd = false; continue;
    }
    if (atCmd) {
      const standalone = after === undefined || /[ \t\n;&|<>()]/.test(after);
      if (standalone && /^(?:then|do|else|elif|if|while|until|time|!|\{)$/.test(word)) { /* still at command position */ }
      else if (standalone && word === 'case') {
        // The skipping scanners (scanClose, dqEnd, rawWords) do not know case patterns: a `)` in one ends a $( ) early.
        if (closer) problem(st, 'case inside a substitution');
        caseDepth++; casePhase = 1; atCmd = false;
      }
      else if (standalone && word === 'esac') {
        casePhase = 0;
        if (caseDepth > 0) caseDepth--; else if (closer) problem(st, 'esac without case');
        atCmd = false;
      } else atCmd = false;
    }
  }

  if (closer && !closed) problem(st, 'unterminated command substitution');
  else if (caseDepth > 0) problem(st, 'case without esac');
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

/** Bash joins backslash-newline before it expands an unquoted body; every other backslash pair is kept as it is. */
function joinContinuations(text) {
  let out = '';
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\' && i + 1 < text.length) {
      if (text[i + 1] !== '\n') out += text.slice(i, i + 2);
      i += 2;
    } else out += text[i++];
  }
  return out;
}

// ── strings that bash runs as code ───────────────────────────────────

const CODE_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'yash', 'posh', 'fish', 'rbash', 'csh', 'tcsh']);
const CODE_PROGS = new Set([...CODE_SHELLS, 'su', 'flock', 'script', 'eval', 'trap', 'env', 'watch', 'find', 'alias']);
const MAX_CODE_STRINGS = 200;
const MAX_COMMAND_WORDS = 32;
const HERESTRING_RE = /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?<<<([\s\S]*)$/;

/** Words of `args` without redirections (an operator alone also drops its operand). */
function withoutRedirs(args) {
  const out = [];
  for (let a = 0; a < args.length; a++) {
    if (REDIR_RE.test(args[a])) { if (REDIR_ONLY_RE.test(args[a])) a++; continue; }
    out.push(args[a]);
  }
  return out;
}

/** The command string of `-c` (shells: the first non-option word when a -c is among the options; su, flock, script:
 *  the word after -c / --command, also in a cluster such as -qc). Dequoted, or null. */
function cString(args, kind) {
  const ws = withoutRedirs(args);
  let sawC = false;
  for (let a = 0; a < ws.length; a++) {
    const d = dequote(ws[a]);
    if (kind === 'shell') {
      if (d === '--') { return sawC && a + 1 < ws.length ? dequote(ws[a + 1]) : null; }
      if (d.length > 1 && (d[0] === '-' || d[0] === '+')) {
        if (d[1] === '-') { if (d === '--rcfile' || d === '--init-file') a++; continue; }
        if (d[0] === '-' && d.slice(1).includes('c')) sawC = true;
        if (/[oO]$/.test(d)) a++;     // -o option-name, -O shopt-name
        continue;
      }
      return sawC ? d : null;
    }
    if (d === '--command') return a + 1 < ws.length ? dequote(ws[a + 1]) : null;
    if (d.startsWith('--command=')) return d.slice(10);
    if (/^-[A-Za-z]*c$/.test(d)) return a + 1 < ws.length ? dequote(ws[a + 1]) : null;
  }
  return null;
}

/** The strings a segment hands to a shell to run as code (each one is scanned as a command by the caller). */
function codeStrings(seg, problems) {
  const ws = rawWords(seg);
  const idx = commandIndexes(ws);
  const out = [];
  let seenWatch = false;      // the first watch holds the rest of the line; later ones are inside it
  // BASH_ALIASES[name]='value' defines an alias like `alias name=value`: its value is code wherever the word stands.
  for (const w of ws) { const m = /^BASH_ALIASES\[[^\]]*\]\+?=([\s\S]+)$/.exec(w); if (m) { const d = dequote(m[1]); if (d) out.push(d); } }
  // Each wrapper word may copy the rest of the segment: examine a bounded number of them, and fail closed past it.
  if (idx.length > MAX_COMMAND_WORDS && Array.isArray(problems) && !problems.includes('too many wrappers') && problems.length < MAX_PROBLEMS) problems.push('too many wrappers');
  for (let n = 0; n < idx.length && n < MAX_COMMAND_WORDS; n++) {
    const k = idx[n];
    const prog = basenameOf(dequote(ws[k]));
    let s = null;
    if (!CODE_PROGS.has(prog)) continue;
    if (prog === 'env') {      // lazily: a chain of env words must not cost a copy of the rest each
      for (let x = k + 1; x < ws.length; x++) {
        if (REDIR_RE.test(ws[x])) { if (REDIR_ONLY_RE.test(ws[x])) x++; continue; }
        const d = dequote(ws[x]);
        if (ASSIGN_RE.test(d)) continue;
        if (d === '-S' || d === '--split-string') { if (x + 1 < ws.length) s = dequote(ws[x + 1]); break; }
        if (d.startsWith('--split-string=')) { s = d.slice(15); break; }
        if (/^-S./.test(d)) { s = d.slice(2); break; }
        if (d === '-u' || d === '-C' || d === '--unset' || d === '--chdir') { x++; continue; }
        if (d[0] === '-') continue;
        break;
      }
      if (s != null && s !== '') out.push(s);
      continue;
    }
    if (prog === 'watch' && seenWatch) continue;
    const args = ws.slice(k + 1);
    if (CODE_SHELLS.has(prog)) {
      s = cString(args, 'shell');
      // a here-string is the shell's standard input, which it runs: <<<"x" or << < then the word
      for (let a = 0; a < args.length; a++) {
        const m = HERESTRING_RE.exec(args[a]);
        if (!m) continue;
        let op = m[1];
        if (op === '') { if (a + 1 < args.length) op = args[++a]; else continue; }
        const d = dequote(op);
        if (d) out.push(d);
      }
    }
    else if (prog === 'alias') {      // alias z='rm -rf x': each value is code that runs when the alias is used
      for (const a of withoutRedirs(args)) {
        const d = dequote(a);
        if (d[0] === '-') continue;
        const e = d.indexOf('=');
        if (e > 0 && e < d.length - 1) out.push(d.slice(e + 1));
      }
    }
    else if (prog === 'su' || prog === 'flock' || prog === 'script') s = cString(args, 'flag');
    else if (prog === 'eval') { const a = withoutRedirs(args).map(dequote); if (a.length) s = a.join(' '); }
    else if (prog === 'trap') {
      const a = withoutRedirs(args).map(dequote);
      let x = 0;
      while (x < a.length && a[x] !== '--' && a[x].length > 1 && a[x][0] === '-') x++;
      if (a[x] === '--') x++;
      if (x < a.length) s = a[x];
    }
    else if (prog === 'watch') { seenWatch = true; if (n + 1 < idx.length) s = ws.slice(idx[n + 1]).map(dequote).join(' '); }
    else if (prog === 'find') {
      for (let x = 0; x < args.length; x++) {
        const d = dequote(args[x]);
        if (d !== '-exec' && d !== '-execdir' && d !== '-ok' && d !== '-okdir') continue;
        let y = x + 1;
        while (y < args.length && !(dequote(args[y]) === ';' || dequote(args[y]) === '+')) y++;
        if (y > x + 1) out.push(args.slice(x + 1, y).join(' '));
        x = y;
      }
    }
    if (s != null && s !== '') out.push(s);
    if (out.length > MAX_CODE_STRINGS) break;
  }
  return out;
}

/** A value made safe to put back into segment text: backslash-escaped, except blanks when `split` (an unquoted
 *  expansion that bash splits into words). */
function escapeValue(v, split) {
  let o = '';
  for (const ch of v) o += /[A-Za-z0-9_.\/:@%+=,~-]/.test(ch) || (split && (ch === ' ' || ch === '\t')) ? ch : '\\' + ch;
  return o;
}

/** A value put into a double-quoted word: only $ ` " \ need an escape there. */
function dqEscapeValue(v) { return v.replace(/[$`"\\]/g, '\\$&'); }

// ── variables that name the program ──────────────────────────────────
//
// `info` is a Map: NAME -> { n, lits, nonlit }: n = how many assignments of NAME the command holds anywhere (every
// segment of every level, code strings and heredoc bodies included), lits = the literal values assigned (at most
// MAX_LITS, none over MAX_LIT_LEN chars), nonlit = some assignment is not a plain literal ($x, $( ), an array, a loop).

const MAX_LITS = 16, MAX_LIT_LEN = 4096, MAX_COMBOS = 64, MAX_EXTRA_SEGMENTS = 5000;
const ASSIGN_WORD_RE = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?)=([\s\S]*)$/;
const NAME_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
const DECL_WORDS = new Set(['declare', 'typeset', 'export', 'readonly', 'local']);

/** { name, plus, lit } of a NAME=value, NAME+=value or NAME[sub]=value word, or null. lit is null when the value is not a literal. */
function wordAssignment(w) {
  const m = ASSIGN_WORD_RE.exec(w);
  if (!m) return null;
  const raw = m[4];
  // an empty value is not trusted either: `c=(rm)` reaches here as `c=` (the lexer reads the parenthesis as a subshell)
  const lit = m[2] || raw === '' || raw[0] === '(' || /[$`]/.test(raw) ? null : dequote(raw);
  return { name: m[1], plus: m[3] === '+', lit };
}

const plainName = (w) => { const d = dequote(w).replace(/\[[^\]]*\]$/, ''); return ASSIGN_NAME_RE.test(d) ? d : null; };

/** The assignments one segment makes (any word NAME=..., and the builtins that set variables), in textual order. */
function segmentAssignments(seg) {
  const ws = rawWords(seg), out = [];
  const handled = new Set();
  const idx = commandIndexes(ws);
  const bare = (name) => out.push({ name, plus: false, lit: null, bare: true });
  const nonlit = (name) => out.push({ name, plus: false, lit: null });
  for (let q = 0; q < idx.length && q < MAX_COMMAND_WORDS; q++) {
    const k = idx[q];
    const prog = basenameOf(dequote(ws[k]));
    const args = ws.slice(k + 1);
    if (DECL_WORDS.has(prog)) {
      let nameref = false;
      for (let a = 0; a < args.length; a++) {
        const w = args[a];
        if (REDIR_RE.test(w)) { if (REDIR_ONLY_RE.test(w)) a++; continue; }
        const d = dequote(w);
        if (d[0] === '-' || d[0] === '+') { if (/^[-+][A-Za-z]*n/.test(d)) nameref = true; continue; }
        const wa = wordAssignment(w) || wordAssignment(d);
        if (wa && nameref) {     // declare -n r=c: assigning r assigns c, so both are non-literal
          handled.add(k + 1 + a); out.push({ name: wa.name, plus: false, lit: null });
          const tgt = /^[A-Za-z_][A-Za-z0-9_]*/.exec(dequote(d.slice(d.indexOf('=') + 1)));
          if (tgt) out.push({ name: tgt[0], plus: false, lit: null });
          continue;
        }
        if (wa) { handled.add(k + 1 + a); out.push(wa); continue; }
        const nm = plainName(w);
        if (nm) { handled.add(k + 1 + a); if (nameref) nonlit(nm); else bare(nm); }
      }
    } else if (prog === 'for' || prog === 'select') {
      const nm = args.length ? plainName(args[0]) : null;
      if (nm) nonlit(nm);
    } else if (prog === 'read' || prog === 'mapfile' || prog === 'readarray') {
      const valued = prog === 'read' ? 'adinNptu' : 'dnOsuCc';
      let any = false;
      for (let a = 0; a < args.length; a++) {
        const w = args[a];
        if (REDIR_RE.test(w)) { if (REDIR_ONLY_RE.test(w)) a++; continue; }
        const d = dequote(w);
        if (d === '--') continue;
        if (d[0] === '-' && d.length > 1) { const last = d[d.length - 1]; if (valued.includes(last) && d.length === 2) a++; continue; }
        const nm = plainName(w);
        if (nm) { nonlit(nm); any = true; }
      }
      if (!any) nonlit(prog === 'read' ? 'REPLY' : 'MAPFILE');
    } else if (prog === 'printf') {
      for (let a = 0; a < args.length - 1; a++) if (dequote(args[a]) === '-v') { const nm = plainName(args[a + 1]); if (nm) nonlit(nm); }
    } else if (prog === 'getopts') {
      const ws2 = withoutRedirs(args);
      const nm = ws2.length > 1 ? plainName(ws2[1]) : null;
      if (nm) nonlit(nm);
      nonlit('OPTARG'); nonlit('OPTIND');
    }
  }
  const anyPos = [];
  // ${NAME:=value} and ${NAME=value} assign NAME when they expand
  for (const m of String(seg).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):?=/g)) anyPos.push({ name: m[1], plus: false, lit: null });
  for (let i = 0; i < ws.length; i++) {
    if (handled.has(i)) continue;
    const wa = wordAssignment(ws[i]);
    if (wa) anyPos.push(wa);
  }
  // textual order: word-position assignments first (they come before the builtins' arguments in the common case)
  return anyPos.concat(out);
}

function noteAssignment(info, ev) {
  let e = info.get(ev.name);
  if (!e) { e = { n: 0, lits: [], nonlit: false }; info.set(ev.name, e); }
  e.n++;
  if (ev.bare) return;
  if (ev.lit === null) { e.nonlit = true; return; }
  const addLit = (v) => { if (v.length <= MAX_LIT_LEN && e.lits.length < MAX_LITS && !e.lits.includes(v)) e.lits.push(v); };
  if (ev.plus) { for (const b of (e.lits.length ? e.lits.slice() : [''])) addLit(b + ev.lit); }
  else addLit(ev.lit);
}

function collectAssignments(segments) {
  const info = new Map();
  for (const seg of segments) for (const ev of segmentAssignments(seg)) noteAssignment(info, ev);
  return info;
}

function mergeAssignments(into, from) {
  if (!(from instanceof Map)) return;
  for (const [name, e] of from) {
    let t = into.get(name);
    if (!t) { t = { n: 0, lits: [], nonlit: false }; into.set(name, t); }
    t.n += e.n; t.nonlit = t.nonlit || e.nonlit;
    for (const v of e.lits) if (t.lits.length < MAX_LITS && !t.lits.includes(v)) t.lits.push(v);
  }
}

/** The assigned names as an array (what scanCommand returns); `.info` (not enumerable) holds the Map above. */
function assignedList(info) {
  const arr = [...info.keys()];
  Object.defineProperty(arr, 'info', { value: info, enumerable: false });
  return arr;
}

/** The Map behind an `assigned` argument: a Map, the result of scanCommand, or any list/set of names (each then counts as assigned many times). */
function assignInfo(assigned) {
  if (!assigned) return null;
  if (assigned instanceof Map) return assigned;
  if (assigned.info instanceof Map) return assigned.info;
  const m = new Map();
  for (const name of assigned) m.set(name, { n: 2, lits: [], nonlit: true });
  return m;
}

/** The $NAME, ${NAME}, ${NAME<operator>...}, ${!NAME...} references of a raw word, outside single quotes, command
 *  substitutions and arithmetic: [{ start, end, name, plain, inDq }]; plain = the whole text of $NAME or ${NAME} (end is set). */
function wordRefs(w) {
  const out = [];
  let inDq = false;
  for (let i = 0; i < w.length;) {
    const c = w[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '"') { inDq = !inDq; i++; continue; }
    if (c === "'" && !inDq) { const e = w.indexOf("'", i + 1); i = e < 0 ? w.length : e + 1; continue; }
    if (c === '`') { i = btEnd(w, i + 1); continue; }
    if (c !== '$') { i++; continue; }
    const d = w[i + 1];
    if (d === "'" && !inDq) { i = Math.min(ansiEnd(w, i + 2) + 1, w.length); continue; }
    if (d === '(' || d === '[') { i = opaqueEnd(w, i); continue; }
    if (d === '"') { i++; continue; }
    if (d === '{') {
      let j = i + 2, bang = false;
      if (w[j] === '!') { bang = true; j++; } else if (w[j] === '#') { i = j + 1; continue; }
      NAME_RE.lastIndex = j;
      const m = NAME_RE.exec(w);
      if (!m) { i += 2; continue; }
      const e = j + m[0].length;
      if (w[e] === '}' && !bang) out.push({ start: i, end: e + 1, name: m[0], plain: true, inDq });
      else out.push({ start: i, end: -1, name: m[0], plain: false, inDq });
      i = e; continue;
    }
    NAME_RE.lastIndex = i + 1;
    const m = d !== undefined ? NAME_RE.exec(w) : null;
    if (m) { out.push({ start: i, end: i + 1 + m[0].length, name: m[0], plain: true, inDq }); i += 1 + m[0].length; continue; }
    i += 2;
  }
  return out;
}

/** True when `w` is exactly one plain reference: $NAME, ${NAME}, "$NAME" or "${NAME}". */
function isWholeRef(w, r) {
  return r.plain && ((r.start === 0 && r.end === w.length) || (w[0] === '"' && w[w.length - 1] === '"' && r.start === 1 && r.end === w.length - 1));
}

/** The extra segments for literal values of variables used as a program: `c=rm; $c -rf x` also yields `rm -rf x`;
 *  with several assignments (`false && c=ls`) every literal value is tried, up to MAX_COMBOS per segment. */
function assignmentSegments(segments, info) {
  const extra = [];
  if (!info || !info.size) return extra;
  for (const seg of segments) {
    let frontier = [seg], made = 0;
    for (let round = 0; round < 4 && frontier.length && made < MAX_COMBOS; round++) {
      const next = [];
      for (const f of frontier) {
        if (made >= MAX_COMBOS) break;
        const ws = rawWords(f);
        const idx = commandIndexes(ws).slice(0, MAX_COMMAND_WORDS);
        const refsAt = new Map(), names = [];
        for (const k of idx) {
          const refs = wordRefs(ws[k]).filter(r => r.plain && info.has(r.name) && info.get(r.name).lits.length);
          if (!refs.length || refs.length > 32) continue;     // $c$c$c... would multiply the value: computed, not expanded
          refsAt.set(k, refs);
          for (const r of refs) if (!names.includes(r.name)) names.push(r.name);
        }
        if (!names.length) continue;
        const pick = names.map(() => 0);
        for (;;) {
          const env = new Map(names.map((nm, x) => [nm, info.get(nm).lits[pick[x]]]));
          const words = ws.map((w, i) => {
            const refs = refsAt.get(i);
            if (!refs) return w;
            // a whole-word reference ("$c") is replaced with its quotes: the value is escaped as one word instead
            if (refs.length === 1 && isWholeRef(w, refs[0])) return escapeValue(env.get(refs[0].name), w[0] !== '"');
            let o = '', prev = 0;
            for (const r of refs) { const v = env.get(r.name); o += w.slice(prev, r.start) + (r.inDq ? dqEscapeValue(v) : escapeValue(v, true)); prev = r.end; }
            return o + w.slice(prev);
          });
          const text = words.join(' ');
          if (text.length > 65536) break;                       // a candidate this large is not built (the program stays computed)
          next.push(text); extra.push(text); made++;
          if (made >= MAX_COMBOS || extra.length >= MAX_EXTRA_SEGMENTS) break;
          let x = 0;
          while (x < names.length && ++pick[x] >= info.get(names[x]).lits.length) pick[x++] = 0;
          if (x >= names.length) break;
        }
        if (extra.length >= MAX_EXTRA_SEGMENTS) return extra;
      }
      frontier = next;
    }
  }
  return extra;
}

function decide(st, depth, maxDepth) {
  const segments = st.segments.slice();
  const problems = st.problems.slice();
  // The variables this command assigns anywhere (own segments here, those of code strings and bodies merged in below).
  const info = collectAssignments(st.segments);
  const add = (r) => {
    for (const x of r.segments) segments.push(x);
    for (const p of r.problems) if (problems.length < MAX_PROBLEMS && !problems.includes(p)) problems.push(p);
    mergeAssignments(info, r.assigned && r.assigned.info);
  };
  // Literal values of assigned variables are put into command words, then every string a segment hands to a shell as code is a command of its own.
  const extras = assignmentSegments(st.segments, info);
  if (extras.length >= MAX_EXTRA_SEGMENTS && !problems.includes('too many substitutions')) problems.push('too many substitutions');
  const own = st.segments.concat(extras);
  for (const x of extras) segments.push(x);
  const shellFed = st.bodies.length > 0 && own.some(isShellFed);
  let codeCount = 0;
  for (const seg of own) {
    // read the segment as written and as bash will run it (b{a..a}sh -c '...'): each code string once
    let strs = codeStrings(seg, problems);
    let norm = seg;
    try { norm = normalizeSegment(seg); } catch { /* the as-written reading stands */ }
    if (norm !== seg) { const seen = new Set(strs); strs = strs.concat(codeStrings(norm, problems).filter(x => !seen.has(x))); }
    for (const code of strs) {
      if (++codeCount > MAX_CODE_STRINGS) { if (!problems.includes('too many command strings')) problems.push('too many command strings'); break; }
      if (depth + 1 > maxDepth) { if (!problems.includes('command strings nested too deeply')) problems.push('command strings nested too deeply'); continue; }
      add(scanCommand(code, { depth: depth + 1, maxDepth }));
    }
  }
  if (st.bodies.length) {
    for (const b of st.bodies) {
      if (shellFed) {
        if (depth + 1 > maxDepth) { if (!problems.includes('heredoc bodies nested too deeply')) problems.push('heredoc bodies nested too deeply'); continue; }
        add(scanCommand(b.quoted ? b.text : unescapeBody(b.text), { depth: depth + 1, maxDepth }));
      }
      if (!b.quoted) add(walkSubs(joinContinuations(b.text), depth, maxDepth));
    }
  }
  // Assignments found in code strings and bodies (eval 'c=rm') are known only now: substitute once more, over every
  // segment (code strings included), keeping only new candidates.
  const seenSeg = new Set(segments);
  for (const x of assignmentSegments(segments.slice(), info)) if (!seenSeg.has(x) && segments.length < MAX_EXTRA_SEGMENTS * 2) { seenSeg.add(x); segments.push(x); }
  // A variable assigned once to a literal and used as a whole word may be resolved instead of counted as computed only in
  // a plain command: NAME=literal segments plus exactly one other, no substitution, code string, heredoc or IFS, and a
  // value without blanks, quotes, expansions or wildcards. Anything richer may change the value unseen (eval, source,
  // a nameref, ${c:=x}, IFS splitting, a glob in the value), so there the program counts as computed.
  let exemptOK = false;
  if (depth === 0 && !st.found && st.bodies.length === 0 && codeCount === 0 && !info.has('IFS')) {
    const plainAssign = /^[A-Za-z_][A-Za-z0-9_]*=[^\s$`*?[\]{}'"\\;&|<>()]*$/;
    exemptOK = st.segments.filter(x => !plainAssign.test(x)).length === 1;
  }
  info.exemptOK = exemptOK;
  // Functions, hash -p names and aliases the command defines shadow real programs: calling one is a computed program.
  const defined = new Set();
  if (depth === 0) {
    const t = st.s;
    for (const m of t.matchAll(/(?:^|[\s;&|(){}])function[ \t]+([A-Za-z_][\w.:-]*)/g)) defined.add(m[1]);
    for (const m of t.matchAll(/(?:^|[\s;&|(){}])([A-Za-z_][\w.:-]*)[ \t]*\([ \t]*\)/g)) defined.add(m[1]);
    for (const m of t.matchAll(/\bhash[ \t]+-[A-Za-z]*p[ \t]+\S+[ \t]+([^\s;&|]+)/g)) defined.add(m[1]);
    for (const m of t.matchAll(/BASH_ALIASES\[['"]?([^\]'"]+)['"]?\]/g)) defined.add(m[1]);
  }
  info.defined = defined;
  return { segments, problems, assigned: assignedList(info) };
}

/** scanCommand(text) -> { ok, segments, problems, assigned }: `assigned` lists the variable names the command assigns
 *  anywhere (pass it to computedProgram). */
function scanCommand(text, { depth = 0, maxDepth = 3 } = {}) {
  const st = newState(String(text == null ? '' : text));
  try {
    lexCmd(st, null);
    const r = decide(st, depth, maxDepth);
    return { ok: r.problems.length === 0, segments: r.segments, problems: r.problems, assigned: r.assigned };
  } catch (e) {
    // Hostile nesting can exhaust the stack (RangeError); whatever it is, the caller falls back to its strictest reading.
    let assigned;
    try { assigned = assignedList(collectAssignments(st.segments)); } catch { assigned = assignedList(new Map()); }
    return { ok: false, segments: st.segments.slice(), problems: [...st.problems, `could not read the command (${e && e.name || 'error'})`], assigned };
  }
}

/** True when the program a segment runs comes from a command substitution ($( ), backticks), from a glob in its path
 *  (/bin/r[m]), or from a brace expansion too large or nested to expand. Unlike dynamicWord, a plain variable ($PY)
 *  does not count: those stay as they are (a program named by an unresolved variable is a documented limit). */
function computedProgram(seg, assigned) {
  const ws = rawWords(seg);
  const info = assignInfo(assigned);
  for (const k of commandIndexes(ws)) {
    const w = ws[k];
    if (w === '[' || w === '[[') continue;
    // A variable this command assigns somewhere is not known to hold what the last visible assignment says (a branch
    // may not run, a subshell's value is gone, ${v:1} cuts it): computed, unless it is assigned exactly once to a
    // literal and used as a whole word ($PY, "${PY}"): that one is resolved to its value by assignmentSegments.
    if (info && info.size) {
      for (const r of wordRefs(w)) {
        const e = info.get(r.name);
        if (!e) continue;
        if (info.exemptOK && e.n === 1 && !e.nonlit && e.lits.length === 1 && isWholeRef(w, r)) continue;
        return true;
      }
    }
    if (info && info.defined && info.defined.size && info.defined.has(basenameOf(dequote(w)))) return true;
    const arith = w.startsWith('((');     // an arithmetic command ((n*2)) is no program; its * ? [ are operators
    for (let i = 0; i < w.length;) {
      const c = w[i];
      if (c === '\\') { i += 2; continue; }
      if (c === "'") { const e = w.indexOf("'", i + 1); i = e < 0 ? w.length : e + 1; continue; }
      if (c === '$' && w[i + 1] === "'") { i = Math.min(ansiEnd(w, i + 2) + 1, w.length); continue; }
      if (c === '$' && w[i + 1] === '(' && w[i + 2] !== '(') return true;
      // $1 ... $9, $0, $@, $*, ${N}, ${!x}, ${#x}: set by set --, a function call or an indirection, not by NAME=
      if (c === '$' && /[0-9@*]/.test(w[i + 1] || '')) return true;
      if (c === '$' && w[i + 1] === '{' && /[0-9@*!#]/.test(w[i + 2] || '')) return true;
      if (c === '`' || (!arith && (c === '*' || c === '?' || c === '['))) return true;
      if (c === '"') {   // $( ) and backticks still run inside double quotes; globs do not
        const e = dqEnd(w, i + 1);
        for (let j = i + 1; j < e - 1; j++) {
          if (w[j] === '\\') { j++; continue; }
          if (w[j] === '`' || (w[j] === '$' && w[j + 1] === '(' && w[j + 2] !== '(')) return true;
          if (w[j] === '$' && (/[0-9@*]/.test(w[j + 1] || '') || (w[j + 1] === '{' && /[0-9@*!#]/.test(w[j + 2] || '')))) return true;
        }
        i = e; continue;
      }
      i++;
    }
    if (!arith && hasBraceExpansion(w) && braceExpandRaw(w) === null) return true;
  }
  return false;
}

module.exports = { scanCommand, segmentWords, SHELL_WORDS, commandWords, normalizeSegment, computedProgram, dequote, rawWords, codeStrings, assignmentSegments, collectAssignments, braceExpandRaw, hasBraceExpansion };
