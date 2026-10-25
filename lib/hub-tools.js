'use strict';
/**
 * The hub's own hands: Bash, Read, Write, Edit, Glob, Grep (plus WebSearch and WebFetch from lib/web-search and
 * lib/web-fetch), one implementation for every path a model is reached by. Gateway agents always use these; Claude
 * client and Codex client agents use them when their `tools` setting is `hub` (or the hub default says so), with the
 * client's own built-in tools switched off, so every agent has the same tools, the policy gate sees every call, and
 * a sandboxed agent's hands act inside its container while the client (and its sign-in) stays on the host.
 *
 * Schemas follow Claude Code's (same names and parameters), because the models are fluent in them. Behaviour follows
 * too: Read returns cat -n style lines, reads PDFs (text, and page images for scanned pages or when `pages` is
 * given) and images; Edit requires a Read first in the same turn, an exact unique match (or replace_all), and shows
 * the edited region; Write refuses to overwrite a file not read this turn; Grep has ripgrep's modes with a pure
 * Node fallback when rg is missing; Glob sorts by modification time; Bash caps output and can run detached as a job.
 *
 * createHubTools(opts) -> { specs(), call(name, args) -> { text, images? }, modeFor }
 *   opts.cwd           working directory for Bash and relative paths
 *   opts.sandbox       { exec(command, { timeoutMs, cwd }) -> { stdout, stderr, code }, mounts: [abs paths] } or null;
 *                      with a sandbox, Bash runs inside it and every file path must be under one of its mounts
 *   opts.allowPrivate  WebFetch may reach private addresses
 *   opts.runJob        async ({ name, command, cwd }) -> text, for Bash run_in_background (null: run in foreground)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const pathConfine = require('./path-confine');

const TOOL_NAMES = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
const CLIENT_BUILTINS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'WebFetch', 'WebSearch'];
const MODES = ['inherit', 'client', 'hub'];
const MAX_OUTPUT = 30000;
const MAX_READ_CHARS = 60000;
const MAX_LINE = 2000;
const IMAGE_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', '.cache']);
const TYPE_GLOBS = {
  js: ['*.js', '*.mjs', '*.cjs', '*.jsx'], ts: ['*.ts', '*.tsx', '*.mts', '*.cts'], py: ['*.py', '*.pyi'], json: ['*.json'], md: ['*.md', '*.markdown'],
  html: ['*.html', '*.htm'], css: ['*.css', '*.scss', '*.less'], sh: ['*.sh', '*.bash', '*.zsh'], go: ['*.go'], rust: ['*.rs'], java: ['*.java'],
  yaml: ['*.yml', '*.yaml'], toml: ['*.toml'], c: ['*.c', '*.h'], cpp: ['*.cpp', '*.cc', '*.hpp', '*.hh'], rb: ['*.rb'], php: ['*.php'], sql: ['*.sql'], txt: ['*.txt'], csv: ['*.csv'],
};

/** Which hands an agent uses: gateway models always the hub's; Claude/Codex clients per agent.tools or the hub default. */
function modeFor(agent, getSetting = () => undefined) {
  const model = String((agent && agent.model) || '');
  if (!/^(claude-sdk|codex-cli)\//.test(model)) return 'hub';
  const own = agent && agent.tools;
  if (own === 'client' || own === 'hub') return own;
  const d = getSetting('toolsDefault');
  return d === 'hub' ? 'hub' : 'client';
}

const SPECS = {
  Bash: {
    description: 'Executes a bash command in a persistent working directory and returns its output. Use for git, build tools, system commands and anything else a shell does. Quote paths with spaces. Prefer the dedicated tools for reading, searching and editing files (Read, Grep, Glob, Edit). Output is capped; long-running work goes through run_in_background and reports when it ends.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        timeout: { type: 'number', description: 'Optional timeout in milliseconds (max 600000)' },
        description: { type: 'string', description: 'Clear, concise description of what this command does in 5-10 words, in active voice' },
        run_in_background: { type: 'boolean', description: 'Run the command detached as a hub job; the hub reports when it exits. Use for anything longer than a minute.' },
      },
      required: ['command'],
    },
  },
  Read: {
    description: 'Reads a file from the local filesystem. The file_path must be absolute. Returns up to 2000 lines by default with line numbers (cat -n format); use offset and limit for parts of large files. Reads images (PNG, JPG, GIF, WebP) and shows them; reads PDFs as text, and shows pages as images when they are scanned or when `pages` is given (e.g. "1-5", max 20 per call); reads Jupyter notebooks as cells. Read a file before editing it.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The absolute path to the file to read' },
        offset: { type: 'number', description: 'The line number to start reading from (1-based). Only provide if the file is too large to read at once' },
        limit: { type: 'number', description: 'The number of lines to read. Only provide if the file is too large to read at once' },
        pages: { type: 'string', description: 'Page range for PDF files (e.g. "1-5", "3", "10-20"). Max 20 pages per request' },
      },
      required: ['file_path'],
    },
  },
  Write: {
    description: 'Writes a file to the local filesystem, overwriting if it exists. Use for creating a new file or fully replacing one you have already Read this turn; overwriting a file you have not read fails. Parent directories are created. For partial changes use Edit.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The absolute path to the file to write (must be absolute, not relative)' },
        content: { type: 'string', description: 'The content to write to the file' },
      },
      required: ['file_path', 'content'],
    },
  },
  Edit: {
    description: 'Performs exact string replacement in a file. You must Read the file in this turn before editing it. old_string must match the file exactly (whitespace and indentation included) and be unique, or the edit fails; use replace_all to change every occurrence. Returns the edited region with line numbers.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'The absolute path to the file to modify' },
        old_string: { type: 'string', description: 'The text to replace' },
        new_string: { type: 'string', description: 'The text to replace it with (must be different from old_string)' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences of old_string (default false)' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  Glob: {
    description: 'Fast file pattern matching. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time, newest first. node_modules and .git are skipped.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The glob pattern to match files against' },
        path: { type: 'string', description: 'The directory to search in. Omit to use the current working directory' },
      },
      required: ['pattern'],
    },
  },
  Grep: {
    description: 'Content search built on ripgrep. Full regex syntax (e.g. "log.*Error", "function\\s+\\w+"); escape literal braces. Filter with glob (e.g. "**/*.tsx") or type (e.g. "js", "py", "rust"). output_mode: "content" (matching lines), "files_with_matches" (paths only, default), or "count". Use -A/-B/-C for context, -i for case-insensitive, multiline for patterns spanning lines, head_limit and offset to page results.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The regular expression pattern to search for in file contents' },
        path: { type: 'string', description: 'File or directory to search in. Defaults to the current working directory' },
        glob: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")' },
        type: { type: 'string', description: 'File type to search (e.g. js, py, rust, go, java, md)' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Output mode; defaults to files_with_matches' },
        '-A': { type: 'number', description: 'Lines to show after each match (content mode)' },
        '-B': { type: 'number', description: 'Lines to show before each match (content mode)' },
        '-C': { type: 'number', description: 'Lines to show before and after each match (content mode)' },
        '-n': { type: 'boolean', description: 'Show line numbers (content mode, default true)' },
        '-i': { type: 'boolean', description: 'Case insensitive search' },
        multiline: { type: 'boolean', description: 'Enable multiline mode where . matches newlines and patterns can span lines' },
        head_limit: { type: 'number', description: 'Limit output to the first N lines/entries (default 250; 0 = unlimited)' },
        offset: { type: 'number', description: 'Skip the first N lines/entries before applying head_limit' },
      },
      required: ['pattern'],
    },
  },
};

/**
 * runShell(cmd, { cwd, timeoutMs, maxBytes }) -> { stdout, stderr, code, signal, timedOut, error }
 * bash -c in its own process group; on timeout the group gets SIGTERM, then SIGKILL two seconds later.
 */
function runShell(cmd, { cwd = process.cwd(), timeoutMs = 120000, maxBytes = 8 * 1024 * 1024, env = { ...process.env, TERM: 'dumb' }, spawnImpl = require('child_process').spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnImpl('bash', ['-c', cmd], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ stdout: '', stderr: '', code: null, signal: null, timedOut: false, error: e.message }); }
    let stdout = '', stderr = '', timedOut = false, done = false, killTimer = null;
    const cap = (s, d) => (s.length < maxBytes ? s + d : s);
    child.stdout.on('data', d => { stdout = cap(stdout, String(d)); });
    child.stderr.on('data', d => { stderr = cap(stderr, String(d)); });
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
    const timer = setTimeout(() => { timedOut = true; killGroup('SIGTERM'); killTimer = setTimeout(() => killGroup('SIGKILL'), 2000); }, timeoutMs);
    const finish = (code, signal, error) => {
      if (done) return; done = true; clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      if (timedOut) killGroup('SIGKILL');   // anything bash left behind in the group goes too
      resolve({ stdout, stderr, code, signal, timedOut, error: error || null });
    };
    child.on('error', (e) => finish(null, null, e.message));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}

function cutOutput(s, max = MAX_OUTPUT) {
  s = String(s == null ? '' : s);
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7), tail = max - head;
  return `${s.slice(0, head)}\n\n... [${s.length - max} characters omitted] ...\n\n${s.slice(-tail)}`;
}
function numbered(lines, start) {
  return lines.map((l, i) => `${String(start + i).padStart(6)}\t${l.length > MAX_LINE ? l.slice(0, MAX_LINE) + '…' : l}`).join('\n');
}
function globToRegExp(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') { if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else if (c === '{') { const j = g.indexOf('}', i); if (j > i) { re += '(' + g.slice(i + 1, j).split(',').map(s => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')'; i = j; } else re += '\\{'; }
    else if ('.+^$()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(`(^|/)${re}$`);
}
function parsePages(spec, max = 20) {
  const m = String(spec || '').trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!m) throw new Error('pages must look like "3" or "1-5"');
  const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
  if (a < 1 || b < a) throw new Error('pages: bad range');
  if (b - a + 1 > max) throw new Error(`pages: at most ${max} pages per call`);
  return { first: a, last: b };
}

function createHubTools({
  cwd = process.cwd(),
  sandbox = null,
  allowPrivate = false,
  runJob = null,
  webSearch = null,
  webFetch = null,
  exec = null,
  preserve = null,                           // (fullText, label) -> void: tiger-team artifacts keep outputs before any cut
  log = (...a) => console.log(...a),
  now = () => Date.now(),
} = {}) {
  const keep = (text, label) => { if (preserve) preserve(text, label); };
  const execFileAsync = exec || promisify(execFile);
  const readThisTurn = new Map();     // abs path -> mtimeMs at read time
  const mounts = sandbox && Array.isArray(sandbox.mounts) ? sandbox.mounts.map(m => path.resolve(m)) : null;
  // Real (symlink-resolved) mount roots. A boxed agent's Bash runs in its container, but these file tools
  // run here in the hub process, so a lexical prefix check would follow a symlink the agent plants in its
  // own writable mount out to any host file. Compare resolved real paths instead.
  const realMounts = mounts ? mounts.map(pathConfine.realRoot) : null;
  let rgPath;                          // undefined = unknown, null = none

  const abs = (p) => { const s = String(p || ''); if (!s) throw new Error('a path is required'); return path.resolve(cwd, s); };
  // true if `a` stays inside the mounts once every symlink on the path is resolved (component by component,
  // including dangling and nested links; see lib/path-confine). Not race-free: the full fix is in-container
  // execution, but this closes the one-shot escape.
  const confined = (a) => {
    if (!realMounts) return true;
    let land; try { land = pathConfine.resolveLanding(a); } catch { return false; }
    return pathConfine.underAny(land, realMounts);
  };
  const inside = (p) => {
    if (!mounts) return;
    const a = abs(p);
    if (!confined(a)) throw new Error(`${a} is not available inside this agent's sandbox (its folders: ${mounts.join(', ')})`);
  };
  async function hasRg() {
    if (rgPath !== undefined) return rgPath;
    try { await execFileAsync('rg', ['--version'], { timeout: 5000 }); rgPath = 'rg'; } catch { rgPath = null; }
    return rgPath;
  }
  async function pdf(file, pages, { imagesWanted }) {
    const range = pages ? parsePages(pages) : null;
    const args = ['-layout']; if (range) args.push('-f', String(range.first), '-l', String(range.last));
    let text = '';
    try { text = (await execFileAsync('pdftotext', [...args, file, '-'], { timeout: 60000, maxBuffer: 16 * 1024 * 1024 })).stdout || ''; }
    catch (e) { if (e && e.code === 'ENOENT') throw new Error('PDF reading needs pdftotext (poppler-utils) on the hub machine'); throw e; }
    const pageTexts = text.split('\f');
    if (pageTexts.length && !pageTexts[pageTexts.length - 1].trim()) pageTexts.pop();
    // No text layer: every page yields nothing but a few OCR-less artifacts. Real text pages have far more.
    const scanned = pageTexts.length > 0 && pageTexts.every(p => p.replace(/\s+/g, '').length < 8);
    const images = [];
    if (imagesWanted || scanned) {
      const first = range ? range.first : 1, last = range ? range.last : Math.min(first + 9, first + pageTexts.length - 1 || first);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-read-'));
      try {
        await execFileAsync('pdftoppm', ['-r', '90', '-png', '-f', String(first), '-l', String(last), file, path.join(tmp, 'p')], { timeout: 120000 });
        for (const f of fs.readdirSync(tmp).sort()) images.push({ mime: 'image/png', base64: fs.readFileSync(path.join(tmp, f)).toString('base64'), label: `${path.basename(file)} page ${f.replace(/^p-?0*|\.png$/g, '')}` });
      } catch (e) { log(`[hub-tools] pdftoppm failed for ${file}: ${e.message}`); }
      finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
    }
    const body = pageTexts.map((p, i) => `--- page ${(range ? range.first : 1) + i} ---\n${p.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()}`).join('\n\n');
    const note = scanned ? `\n\n(no text layer: ${images.length} page image(s) attached)` : images.length ? `\n\n(${images.length} page image(s) attached)` : range ? '' : '\n\n(pass pages: "1-5" to see page images)';
    return { text: cutOutput(body || '(no text in this PDF)', MAX_READ_CHARS) + note, images };
  }

  const impl = {
    async Bash({ command, timeout, run_in_background }) {
      const cmd = String(command || '');
      if (!cmd.trim()) return { text: 'Error: command is empty' };
      const ms = Math.min(Math.max(Number(timeout) || 120000, 1000), 600000);
      if (run_in_background) {
        if (!runJob) return { text: 'Error: background runs are not available here; run the command in the foreground with a timeout, or use run_job.' };
        return { text: await runJob({ name: cmd.slice(0, 60), command: cmd, cwd }) };
      }
      const trim = (s) => String(s || '').replace(/\s+$/, '');
      if (sandbox) {
        const r = await sandbox.exec(cmd, { timeoutMs: ms, cwd });
        keep((r.stdout || '') + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : ''), r.code ? 'Bash:error' : 'Bash:success');
        let out = trim(r.stdout);
        if (trim(r.stderr)) out += (out ? '\n' : '') + `[stderr]\n${trim(r.stderr)}`;
        if (r.code) out += (out ? '\n' : '') + `[exit code ${r.code}]`;
        return { text: cutOutput(out) || '(no output)' };
      }
      // Own process group: a timeout kills the whole pipeline (grep | head, python children...), never just bash,
      // so a runaway command cannot outlive the tool call (the cause of a 20-minute hung turn on 2026-10-13).
      const r = await runShell(cmd, { cwd, timeoutMs: ms });
      keep((r.stdout || '') + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : '') || (r.error || ''), r.code === 0 && !r.timedOut ? 'Bash:success' : 'Bash:error');
      if (r.code === 0 && !r.timedOut) {
        let out = trim(r.stdout);
        if (trim(r.stderr)) out += (out ? '\n' : '') + trim(r.stderr);
        return { text: cutOutput(out) || '(no output)' };
      }
      let msg = trim(r.stdout);
      if (trim(r.stderr)) msg += (msg ? '\n' : '') + trim(r.stderr);
      if (r.timedOut) msg += `${msg ? '\n' : ''}[timed out after ${ms} ms; the command and its children were killed]`;
      return { text: cutOutput(`Error (exit ${r.code == null ? '?' : r.code}): ${msg || r.error || 'failed'}`) };
    },

    async Read({ file_path, offset, limit, pages }) {
      const file = abs(file_path); inside(file);
      let st;
      try { st = fs.statSync(file); } catch (e) { return { text: `Error: ${e.code === 'ENOENT' ? `file not found: ${file}` : e.message}` }; }
      if (st.isDirectory()) return { text: `Error: ${file} is a directory (use Glob or Bash ls)` };
      const ext = path.extname(file).toLowerCase();
      if (IMAGE_EXT[ext]) {
        if (st.size > 8 * 1024 * 1024) return { text: `Error: image is ${st.size} bytes; too large to show (8 MB limit)` };
        readThisTurn.set(file, st.mtimeMs);
        return { text: `[image: ${path.basename(file)}, ${st.size} bytes]`, images: [{ mime: IMAGE_EXT[ext], base64: fs.readFileSync(file).toString('base64'), label: path.basename(file) }] };
      }
      const head = Buffer.alloc(5); try { const fd = fs.openSync(file, 'r'); fs.readSync(fd, head, 0, 5, 0); fs.closeSync(fd); } catch {}
      if (ext === '.pdf' || head.toString() === '%PDF-') {
        readThisTurn.set(file, st.mtimeMs);
        return pdf(file, pages, { imagesWanted: !!pages });
      }
      if (ext === '.ipynb') {
        try {
          const nb = JSON.parse(fs.readFileSync(file, 'utf8'));
          const cells = (nb.cells || []).map((c, i) => `# cell ${i + 1} (${c.cell_type})\n${(Array.isArray(c.source) ? c.source.join('') : c.source || '').trimEnd()}${c.outputs && c.outputs.length ? `\n# outputs: ${c.outputs.map(o => (o.text ? (Array.isArray(o.text) ? o.text.join('') : o.text) : o.data && o.data['text/plain'] ? [].concat(o.data['text/plain']).join('') : o.output_type)).join(' | ').slice(0, 2000)}` : ''}`);
          readThisTurn.set(file, st.mtimeMs);
          return { text: cutOutput(cells.join('\n\n'), MAX_READ_CHARS) };
        } catch (e) { return { text: `Error: cannot parse notebook: ${e.message}` }; }
      }
      if (st.size > 64 * 1024 * 1024) return { text: `Error: file is ${st.size} bytes; read it in parts with Bash (head, sed -n) instead` };
      const buf = fs.readFileSync(file);
      if (buf.length > 1024 && buf.subarray(0, 1024).includes(0)) return { text: `(binary file, ${buf.length} bytes; not shown)` };
      const content = buf.toString('utf8');
      readThisTurn.set(file, st.mtimeMs);
      if (!content.length) return { text: '(empty file)' };
      const all = content.split('\n');
      if (all.length && all[all.length - 1] === '') all.pop();
      const start = Math.max(1, Math.floor(Number(offset) || 1));
      const count = Number(limit) > 0 ? Math.floor(Number(limit)) : 2000;
      const slice = all.slice(start - 1, start - 1 + count);
      if (!slice.length) return { text: `(no lines from ${start}; the file has ${all.length} line(s))` };
      keep(slice.map((l, i) => `${String(start + i).padStart(6)}\t${l}`).join('\n'), `Read:full:${file}`);
      let text = numbered(slice, start);
      if (text.length > MAX_READ_CHARS) text = cutOutput(text, MAX_READ_CHARS) + '\n(use offset and limit to read the rest)';
      else if (start - 1 + slice.length < all.length) text += `\n\n(${all.length - (start - 1 + slice.length)} more line(s); continue with offset: ${start + slice.length})`;
      return { text };
    },

    async Write({ file_path, content }) {
      const file = abs(file_path); inside(file);
      if (content === undefined || content === null) return { text: 'Error: content is required' };
      const body = String(content);
      let st = null; try { st = fs.statSync(file); } catch {}
      if (st) {
        const seen = readThisTurn.get(file);
        if (seen === undefined) return { text: `Error: ${file} exists and has not been read this turn. Read it first (or use Edit for a partial change).` };
        if (seen !== st.mtimeMs) return { text: `Error: ${file} changed on disk since you read it. Read it again before writing.` };
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body, 'utf8');
      readThisTurn.set(file, fs.statSync(file).mtimeMs);
      return { text: `${st ? 'Updated' : 'Created'} ${file} (${body.length} characters, ${body.split('\n').length} lines)` };
    },

    async Edit({ file_path, old_string, new_string, replace_all }) {
      const file = abs(file_path); inside(file);
      const oldS = String(old_string == null ? '' : old_string), newS = String(new_string == null ? '' : new_string);
      if (!oldS) return { text: 'Error: old_string is empty' };
      if (oldS === newS) return { text: 'Error: old_string and new_string are identical' };
      let st; try { st = fs.statSync(file); } catch (e) { return { text: `Error: file not found: ${file}` }; }
      const seen = readThisTurn.get(file);
      if (seen === undefined) return { text: `Error: ${file} has not been read this turn. Read it first, then edit.` };
      if (seen !== st.mtimeMs) return { text: `Error: ${file} changed on disk since you read it. Read it again before editing.` };
      const content = fs.readFileSync(file, 'utf8');
      const first = content.indexOf(oldS);
      if (first < 0) return { text: `Error: old_string not found in ${file}. It must match exactly, including whitespace and indentation.` };
      let count = 0; for (let i = first; i >= 0; i = content.indexOf(oldS, i + oldS.length)) count++;
      let out;
      if (replace_all) out = content.split(oldS).join(newS);
      else {
        if (count > 1) return { text: `Error: old_string is not unique in ${file} (occurs ${count} times). Include more surrounding text to make it unique, or set replace_all: true.` };
        out = content.slice(0, first) + newS + content.slice(first + oldS.length);
      }
      keep(out, `Edit:result:${file}`);
      fs.writeFileSync(file, out, 'utf8');
      readThisTurn.set(file, fs.statSync(file).mtimeMs);
      const lineAt = out.slice(0, first).split('\n').length;
      const lines = out.split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      const from = Math.max(1, lineAt - 3), to = Math.min(lines.length, lineAt + newS.split('\n').length + 2);
      return { text: `${replace_all ? `Replaced ${count} occurrence(s) in` : 'Edited'} ${file}. The region now reads:\n${numbered(lines.slice(from - 1, to), from)}` };
    },

    async Glob({ pattern, path: dir }) {
      const base = dir ? abs(dir) : cwd; if (dir) inside(base);
      const pat = String(pattern || '').trim();
      if (!pat) return { text: 'Error: pattern is required' };
      let files;
      try { files = fs.globSync(pat, { cwd: base, exclude: (name) => SKIP_DIRS.has(path.basename(String(name))) }); }
      catch (e) { return { text: `Error: ${e.message}` }; }
      const rows = [];
      for (const f of files) {
        const full = path.resolve(base, f);
        if (realMounts && !confined(full)) continue;   // never list a match that resolves outside the box
        try { const st = fs.statSync(full); if (st.isFile()) rows.push({ full, m: st.mtimeMs }); } catch {}
      }
      if (!rows.length) return { text: '(no matches)' };
      rows.sort((a, b) => b.m - a.m);
      keep(rows.map(r => r.full).join('\n'), `Glob:${pat}`);
      const shown = rows.slice(0, 200).map(r => r.full);
      return { text: shown.join('\n') + (rows.length > 200 ? `\n(${rows.length - 200} more; narrow the pattern)` : '') };
    },

    async Grep(args) {
      const pattern = String(args.pattern || ''); if (!pattern) return { text: 'Error: pattern is required' };
      const target = args.path ? abs(args.path) : cwd; if (args.path) inside(target);
      const mode = ['content', 'files_with_matches', 'count'].includes(args.output_mode) ? args.output_mode : 'files_with_matches';
      const ctxA = Math.max(0, Number(args['-A']) || Number(args['-C']) || 0), ctxB = Math.max(0, Number(args['-B']) || Number(args['-C']) || 0);
      const showN = args['-n'] !== false, ci = !!args['-i'], multi = !!args.multiline;
      const headLimit = args.head_limit === 0 ? 0 : Math.max(0, Number(args.head_limit) || 250);
      const skip = Math.max(0, Number(args.offset) || 0);
      const globs = [];
      if (args.glob) globs.push(String(args.glob));
      if (args.type) { const g = TYPE_GLOBS[String(args.type).toLowerCase()]; if (!g) return { text: `Error: unknown type "${args.type}"; use a glob instead` }; globs.push(...g); }
      let lines;
      const rg = await hasRg();
      if (rg) {
        const a = ['--no-messages', '--color', 'never'];
        if (mode === 'files_with_matches') a.push('-l'); else if (mode === 'count') a.push('-c'); else { a.push('--no-heading', '-H'); if (showN) a.push('-n'); if (ctxA) a.push('-A', String(ctxA)); if (ctxB) a.push('-B', String(ctxB)); }
        if (ci) a.push('-i'); if (multi) a.push('-U', '--multiline-dotall');
        for (const g of globs) a.push('--glob', g);
        for (const d of SKIP_DIRS) a.push('--glob', `!**/${d}/**`);
        a.push('-e', pattern, target);
        try { const r = await execFileAsync(rg, a, { timeout: 60000, maxBuffer: 16 * 1024 * 1024 }); lines = (r.stdout || '').split('\n').filter(Boolean); }
        catch (e) { if (e.code === 1) lines = []; else return { text: `Error: ${e.stderr || e.message}` }; }
      } else lines = nodeGrep({ pattern, target, mode, ctxA, ctxB, showN, ci, multi, globs });
      if (lines instanceof Error) return { text: `Error: ${lines.message}` };
      const total = lines.length;
      keep(lines.join('\n'), `Grep:${pattern}`);
      const page = lines.slice(skip, headLimit ? skip + headLimit : undefined);
      if (!page.length) return { text: total ? `(no entries after offset ${skip}; ${total} in total)` : '(no matches)' };
      const tail = headLimit && skip + headLimit < total ? `\n(${total - skip - headLimit} more; continue with offset: ${skip + headLimit})` : '';
      return { text: cutOutput(page.join('\n')) + tail };
    },

    async WebSearch(args) {
      const ws = webSearch || require('./web-search').getWebSearch();
      const r = await ws.search(args.query, { maxResults: args.max_results, freshness: args.freshness, backend: args.backend });
      return { text: ws.render(r) };
    },
    async WebFetch(args) {
      const wf = webFetch || require('./web-fetch').getWebFetch();
      return { text: await wf.toolText({ url: args.url, max_length: args.max_length, offset: args.offset, render: args.render === true }, { allowPrivate }) };
    },
  };

  /** Pure-Node grep for machines without ripgrep: walks text files under target, honours globs and modes. */
  function nodeGrep({ pattern, target, mode, ctxA, ctxB, showN, ci, multi, globs }) {
    let re;
    try { re = new RegExp(pattern, (ci ? 'i' : '') + (multi ? 's' : '') + 'g'); } catch (e) { return new Error(`bad regex: ${e.message}`); }
    const matchers = globs.map(globToRegExp);
    const files = [];
    const walk = (p, depth) => {
      if (realMounts && !confined(p)) return;   // never follow a symlink out of the box (ripgrep does not follow; this fallback must not either)
      let st; try { st = fs.statSync(p); } catch { return; }
      if (st.isFile()) { if (st.size <= 2 * 1024 * 1024 && (!matchers.length || matchers.some(m => m.test(p)))) files.push(p); return; }
      if (!st.isDirectory() || depth > 25) return;
      let names; try { names = fs.readdirSync(p); } catch { return; }
      for (const n of names) { if (SKIP_DIRS.has(n)) continue; walk(path.join(p, n), depth + 1); }
    };
    walk(target, 0);
    const out = [];
    for (const f of files) {
      let buf; try { buf = fs.readFileSync(f); } catch { continue; }
      if (buf.subarray(0, 1024).includes(0)) continue;
      const text = buf.toString('utf8');
      if (multi) {
        re.lastIndex = 0; const m = re.exec(text); if (!m) continue;
        if (mode === 'files_with_matches') { out.push(f); continue; }
        if (mode === 'count') { let c = 1; while (re.exec(text)) c++; out.push(`${f}:${c}`); continue; }
        re.lastIndex = 0; let mm; while ((mm = re.exec(text)) && out.length < 5000) { const ln = text.slice(0, mm.index).split('\n').length; out.push(`${f}${showN ? `:${ln}` : ''}:${mm[0].split('\n')[0]}`); if (!mm[0]) re.lastIndex++; }
        continue;
      }
      const lines = text.split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      const hits = [];
      for (let i = 0; i < lines.length; i++) { re.lastIndex = 0; if (re.test(lines[i])) hits.push(i); }
      if (!hits.length) continue;
      if (mode === 'files_with_matches') { out.push(f); continue; }
      if (mode === 'count') { out.push(`${f}:${hits.length}`); continue; }
      const hitSet = new Set(hits);
      let lastShown = -1;
      for (const i of hits) {
        const from = Math.max(0, i - ctxB), to = Math.min(lines.length - 1, i + ctxA);
        if (lastShown >= 0 && from > lastShown + 1) out.push('--');
        for (let j = Math.max(from, lastShown + 1); j <= to; j++) { const sep = hitSet.has(j) ? ':' : '-'; out.push(`${f}${showN ? `${sep}${j + 1}` : ''}${sep}${lines[j]}`); }
        lastShown = Math.max(lastShown, to);
      }
    }
    return out;
  }

  function specs() {
    const out = TOOL_NAMES.map(name => {
      if (name === 'WebSearch' || name === 'WebFetch') { const t = require('./provider-tools').BUILTIN_TOOLS[name]; return { name, description: t.description, parameters: t.parameters }; }
      return { name, description: SPECS[name].description, parameters: SPECS[name].parameters };
    });
    return out;
  }
  async function call(name, args = {}) {
    const fn = impl[name];
    if (!fn) return { text: `Error: unknown tool ${name}` };
    try { const r = await fn(args || {}); return typeof r === 'string' ? { text: r } : r; }
    catch (e) { if (e && e.code === 'TT_PERSISTENCE_FAILED') throw e; return { text: `Error: ${e.message}` }; }
  }
  function markRead(file) { try { readThisTurn.set(abs(file), fs.statSync(abs(file)).mtimeMs); } catch {} }

  return { specs, call, modeFor, markRead, readThisTurn, cwd, sandboxed: !!sandbox, TOOL_NAMES, CLIENT_BUILTINS };
}

module.exports = { createHubTools, modeFor, runShell, SPECS, TOOL_NAMES, CLIENT_BUILTINS, MODES, globToRegExp, parsePages, cutOutput };
