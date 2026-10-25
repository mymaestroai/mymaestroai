'use strict';
// The hub's hands (lib/hub-tools): Read (text, offset/limit, images, PDFs, notebooks, binaries), Write and Edit
// rules (read first, exact unique match, replace_all, changed-on-disk), Glob (mtime order), Grep (modes, context,
// type/glob filters, paging; the pure-Node fallback is exercised by forcing rg absent), Bash (cwd, exit codes,
// timeout, background via the job hook, sandbox exec), sandbox path confinement, mode resolution and schemas.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createHubTools, modeFor, SPECS, TOOL_NAMES, CLIENT_BUILTINS, globToRegExp, parsePages, cutOutput } = require('../lib/hub-tools');

function dir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hubtools-'));
  fs.mkdirSync(path.join(d, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(d, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(d, 'a.txt'), 'alpha\nbeta gamma\n\tindented beta\n');
  fs.writeFileSync(path.join(d, 'src', 'b.js'), 'const x = 1;\nfunction beta() {}\nbeta();\n');
  fs.writeFileSync(path.join(d, 'src', 'deep', 'c.py'), 'def beta():\n    pass\n');
  fs.writeFileSync(path.join(d, 'node_modules', 'x', 'beta.js'), 'beta');
  fs.writeFileSync(path.join(d, 'bin.dat'), Buffer.concat([Buffer.from('abc'), Buffer.alloc(2000, 0)]));
  fs.writeFileSync(path.join(d, 'img.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  return d;
}
// A tool instance whose Grep never finds rg (so the Node fallback runs) unless o.rg is true.
function tools(d, o = {}) {
  const realExec = require('util').promisify(require('child_process').execFile);
  const exec = async (file, args, opts) => {
    if (file === 'rg' && !o.rg) { const e = new Error('spawn rg ENOENT'); e.code = 'ENOENT'; throw e; }
    return realExec(file, args, opts);
  };
  return createHubTools({ cwd: d, exec, log: () => {}, ...o });
}
const has = (bin) => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };

test('schemas: the eight hands, Claude Code parameter names, client built-ins list', () => {
  assert.deepStrictEqual(TOOL_NAMES, ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);
  assert.deepStrictEqual(Object.keys(SPECS.Read.parameters.properties), ['file_path', 'offset', 'limit', 'pages']);
  assert.deepStrictEqual(Object.keys(SPECS.Edit.parameters.properties), ['file_path', 'old_string', 'new_string', 'replace_all']);
  assert.deepStrictEqual(Object.keys(SPECS.Grep.parameters.properties), ['pattern', 'path', 'glob', 'type', 'output_mode', '-A', '-B', '-C', '-n', '-i', 'multiline', 'head_limit', 'offset']);
  assert.deepStrictEqual(Object.keys(SPECS.Bash.parameters.properties), ['command', 'timeout', 'description', 'run_in_background']);
  assert.deepStrictEqual(Object.keys(SPECS.Glob.parameters.properties), ['pattern', 'path']);
  assert.deepStrictEqual(CLIENT_BUILTINS, ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'WebFetch', 'WebSearch']);
  const t = tools(dir());
  assert.deepStrictEqual(t.specs().map(s => s.name), TOOL_NAMES);
  for (const s of t.specs()) assert.ok(s.description.length > 40 && s.parameters.type === 'object', s.name);
});

test('modeFor: gateway models always hub; client models follow the agent field, then the hub default, then client', () => {
  assert.strictEqual(modeFor({ model: 'openai/gpt-5.6-sol' }), 'hub');
  assert.strictEqual(modeFor({ model: 'ninfer/qwen3.8-27b', tools: 'client' }), 'hub');
  assert.strictEqual(modeFor({ model: 'claude-sdk/claude-fable-5-1' }), 'client');
  assert.strictEqual(modeFor({ model: 'claude-sdk/claude-fable-5-1' }, () => 'hub'), 'hub');
  assert.strictEqual(modeFor({ model: 'claude-sdk/claude-fable-5-1', tools: 'client' }, () => 'hub'), 'client');
  assert.strictEqual(modeFor({ model: 'codex-cli/gpt-6-astra', tools: 'hub' }), 'hub');
  assert.strictEqual(modeFor({ model: 'codex-cli/gpt-6-astra', tools: 'inherit' }, () => 'client'), 'client');
});

test('Read: numbered lines, offset/limit with a continuation note, empty, missing, directory, binary, image', async () => {
  const d = dir(); const t = tools(d);
  let r = await t.call('Read', { file_path: path.join(d, 'a.txt') });
  assert.strictEqual(r.text, '     1\talpha\n     2\tbeta gamma\n     3\t\tindented beta');
  r = await t.call('Read', { file_path: 'a.txt', offset: 2, limit: 1 });
  assert.strictEqual(r.text, '     2\tbeta gamma\n\n(1 more line(s); continue with offset: 3)');
  fs.writeFileSync(path.join(d, 'empty'), '');
  assert.strictEqual((await t.call('Read', { file_path: path.join(d, 'empty') })).text, '(empty file)');
  assert.match((await t.call('Read', { file_path: path.join(d, 'nope') })).text, /file not found/);
  assert.match((await t.call('Read', { file_path: d })).text, /is a directory/);
  assert.match((await t.call('Read', { file_path: path.join(d, 'bin.dat') })).text, /binary file, 2003 bytes/);
  r = await t.call('Read', { file_path: path.join(d, 'img.png') });
  assert.match(r.text, /\[image: img\.png, 16 bytes\]/);
  assert.strictEqual(r.images.length, 1);
  assert.strictEqual(r.images[0].mime, 'image/png');
  assert.strictEqual(Buffer.from(r.images[0].base64, 'base64').length, 16);
  const long = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n');
  fs.writeFileSync(path.join(d, 'long.txt'), long);
  r = await t.call('Read', { file_path: path.join(d, 'long.txt') });
  assert.match(r.text, /^ {5}1\tline 1\n/);
  assert.match(r.text, /\(1000 more line\(s\); continue with offset: 2001\)$/);
  fs.writeFileSync(path.join(d, 'wide.txt'), 'x'.repeat(5000));
  assert.ok((await t.call('Read', { file_path: path.join(d, 'wide.txt') })).text.length < 2100, 'long lines are cut');
});

test('Read: Jupyter notebooks come back as cells', async () => {
  const d = dir(); const t = tools(d);
  fs.writeFileSync(path.join(d, 'n.ipynb'), JSON.stringify({ cells: [{ cell_type: 'markdown', source: ['# Title'] }, { cell_type: 'code', source: 'print(1)', outputs: [{ output_type: 'stream', text: ['1\n'] }] }] }));
  const r = await t.call('Read', { file_path: path.join(d, 'n.ipynb') });
  assert.match(r.text, /# cell 1 \(markdown\)\n# Title\n\n# cell 2 \(code\)\nprint\(1\)\n# outputs: 1/);
});

test('Read: PDFs give page text, page images when scanned or when pages is given; page ranges validated', { skip: !has('pdftotext') || !has('pdftoppm') ? 'poppler-utils not installed' : false }, async () => {
  const d = dir(); const t = tools(d);
  // A minimal one-page PDF with a text object; pdftotext reconstructs the xref.
  const pdf = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 20 40 Td (Hello Hub PDF) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>`;
  fs.writeFileSync(path.join(d, 'doc.pdf'), pdf);
  let r = await t.call('Read', { file_path: path.join(d, 'doc.pdf') });
  assert.match(r.text, /--- page 1 ---\nHello Hub PDF/);
  assert.match(r.text, /pass pages: "1-5" to see page images/);
  assert.strictEqual((r.images || []).length, 0, 'a text PDF without pages: text only');
  r = await t.call('Read', { file_path: path.join(d, 'doc.pdf'), pages: '1' });
  assert.strictEqual(r.images.length, 1);
  assert.strictEqual(r.images[0].mime, 'image/png');
  assert.match(r.images[0].label, /doc\.pdf page 1/);
  assert.match(r.text, /1 page image\(s\) attached/);
  // A page with no text layer counts as scanned: images come without asking
  const blank = pdf.replace('(Hello Hub PDF) Tj', '() Tj');
  fs.writeFileSync(path.join(d, 'scan.pdf'), blank);
  r = await t.call('Read', { file_path: path.join(d, 'scan.pdf') });
  assert.match(r.text, /no text layer: 1 page image\(s\) attached/);
  assert.strictEqual(r.images.length, 1);
  assert.match((await t.call('Read', { file_path: path.join(d, 'doc.pdf'), pages: '1-40' })).text, /at most 20 pages/);
  assert.match((await t.call('Read', { file_path: path.join(d, 'doc.pdf'), pages: 'x' })).text, /pages must look like/);
  assert.deepStrictEqual(parsePages('3'), { first: 3, last: 3 });
  assert.deepStrictEqual(parsePages('2-5'), { first: 2, last: 5 });
});

test('Edit: read first, exact unique match, replace_all, identical strings, changed on disk; shows the region', async () => {
  const d = dir(); const t = tools(d);
  const f = path.join(d, 'src', 'b.js');
  assert.match((await t.call('Edit', { file_path: f, old_string: 'beta', new_string: 'delta' })).text, /has not been read this turn/);
  await t.call('Read', { file_path: f });
  assert.match((await t.call('Edit', { file_path: f, old_string: 'beta', new_string: 'delta' })).text, /occurs 2 times/);
  assert.match((await t.call('Edit', { file_path: f, old_string: 'nothere', new_string: 'x' })).text, /not found/);
  assert.match((await t.call('Edit', { file_path: f, old_string: 'beta', new_string: 'beta' })).text, /identical/);
  let r = await t.call('Edit', { file_path: f, old_string: 'function beta()', new_string: 'function delta()' });
  assert.match(r.text, /^Edited .*b\.js\. The region now reads:\n {5}1\tconst x = 1;\n {5}2\tfunction delta\(\) \{\}\n {5}3\tbeta\(\);$/);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'const x = 1;\nfunction delta() {}\nbeta();\n');
  r = await t.call('Edit', { file_path: f, old_string: 'beta', new_string: 'delta', replace_all: true });
  assert.match(r.text, /Replaced 1 occurrence\(s\)/);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'const x = 1;\nfunction delta() {}\ndelta();\n');
  // someone else changes the file: the registry notices
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(f, future, future);
  assert.match((await t.call('Edit', { file_path: f, old_string: 'delta', new_string: 'x', replace_all: true })).text, /changed on disk/);
  assert.match((await t.call('Edit', { file_path: path.join(d, 'nope.js'), old_string: 'a', new_string: 'b' })).text, /file not found/);
  assert.match((await t.call('Edit', { file_path: f, old_string: '', new_string: 'b' })).text, /old_string is empty/);
});

test('Write: creates new files (and folders), refuses to overwrite an unread file, registers what it wrote', async () => {
  const d = dir(); const t = tools(d);
  const f = path.join(d, 'new', 'deep', 'file.txt');
  assert.match((await t.call('Write', { file_path: f, content: 'hello\nworld\n' })).text, /^Created .*file\.txt \(12 characters, 3 lines\)/);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'hello\nworld\n');
  assert.match((await t.call('Write', { file_path: path.join(d, 'a.txt'), content: 'x' })).text, /exists and has not been read this turn/);
  await t.call('Read', { file_path: path.join(d, 'a.txt') });
  assert.match((await t.call('Write', { file_path: path.join(d, 'a.txt'), content: 'x' })).text, /^Updated/);
  assert.match((await t.call('Edit', { file_path: f, old_string: 'world', new_string: 'hub' })).text, /^Edited/, 'a file this turn wrote counts as read');
});

test('Glob: patterns with braces and **, newest first, node_modules skipped, path argument', async () => {
  const d = dir(); const t = tools(d);
  const future = new Date(Date.now() + 10000);
  fs.utimesSync(path.join(d, 'src', 'deep', 'c.py'), future, future);
  let r = await t.call('Glob', { pattern: '**/*.{js,py}' });
  assert.deepStrictEqual(r.text.split('\n'), [path.join(d, 'src', 'deep', 'c.py'), path.join(d, 'src', 'b.js')]);
  r = await t.call('Glob', { pattern: '*.js', path: path.join(d, 'src') });
  assert.strictEqual(r.text, path.join(d, 'src', 'b.js'));
  assert.strictEqual((await t.call('Glob', { pattern: '**/*.zig' })).text, '(no matches)');
  assert.match((await t.call('Glob', { pattern: '' })).text, /pattern is required/);
  assert.ok(globToRegExp('*.{ts,tsx}').test('a/b.tsx') && !globToRegExp('*.{ts,tsx}').test('a/b.js'));
  assert.ok(globToRegExp('**/*.js').test('deep/x/y.js') && globToRegExp('src/**/*.js').test('src/a/b.js'));
});

test('Grep (Node fallback): files_with_matches, content with context, count, -i, glob, type, head_limit/offset, multiline', async () => {
  const d = dir(); const t = tools(d);
  let r = await t.call('Grep', { pattern: 'beta' });
  const files = r.text.split('\n').sort();
  assert.deepStrictEqual(files, [path.join(d, 'a.txt'), path.join(d, 'src', 'b.js'), path.join(d, 'src', 'deep', 'c.py')], 'node_modules skipped');
  r = await t.call('Grep', { pattern: 'beta', path: path.join(d, 'a.txt'), output_mode: 'content', '-C': 1 });
  assert.strictEqual(r.text, `${path.join(d, 'a.txt')}-1-alpha\n${path.join(d, 'a.txt')}:2:beta gamma\n${path.join(d, 'a.txt')}:3:\tindented beta`);
  r = await t.call('Grep', { pattern: 'BETA', '-i': true, output_mode: 'count', path: path.join(d, 'src') });
  assert.deepStrictEqual(r.text.split('\n').sort(), [`${path.join(d, 'src', 'b.js')}:2`, `${path.join(d, 'src', 'deep', 'c.py')}:1`]);
  assert.strictEqual((await t.call('Grep', { pattern: 'beta', type: 'py' })).text, path.join(d, 'src', 'deep', 'c.py'));
  assert.strictEqual((await t.call('Grep', { pattern: 'beta', glob: '*.js' })).text, path.join(d, 'src', 'b.js'));
  assert.match((await t.call('Grep', { pattern: 'beta', type: 'cobol' })).text, /unknown type/);
  assert.strictEqual((await t.call('Grep', { pattern: 'zzz' })).text, '(no matches)');
  r = await t.call('Grep', { pattern: 'beta', output_mode: 'content', path: path.join(d, 'src', 'b.js'), head_limit: 1 });
  assert.match(r.text, /:2:function beta\(\) \{\}\n\(1 more; continue with offset: 1\)$/);
  r = await t.call('Grep', { pattern: 'beta', output_mode: 'content', path: path.join(d, 'src', 'b.js'), head_limit: 1, offset: 1 });
  assert.match(r.text, /:3:beta\(\);$/);
  r = await t.call('Grep', { pattern: 'const x.*beta\\(\\)', multiline: true, output_mode: 'files_with_matches' });
  assert.strictEqual(r.text, path.join(d, 'src', 'b.js'));
  assert.match((await t.call('Grep', { pattern: '(' })).text, /bad regex/);
  r = await t.call('Grep', { pattern: 'beta', output_mode: 'content', '-n': false, path: path.join(d, 'src', 'b.js') });
  assert.strictEqual(r.text, `${path.join(d, 'src', 'b.js')}:function beta() {}\n${path.join(d, 'src', 'b.js')}:beta();`);
});

test('Grep (ripgrep) gives the same answers when rg is present', { skip: !has('rg') ? 'rg not installed' : false }, async () => {
  const d = dir(); const t = tools(d, { rg: true });
  assert.deepStrictEqual((await t.call('Grep', { pattern: 'beta' })).text.split('\n').sort(), [path.join(d, 'a.txt'), path.join(d, 'src', 'b.js'), path.join(d, 'src', 'deep', 'c.py')]);
  assert.match((await t.call('Grep', { pattern: 'beta', output_mode: 'count', path: path.join(d, 'src', 'b.js') })).text, /:2$/);
});

test('Bash: runs in the cwd, reports exit codes and stderr, times out, caps output, background goes to the job hook', async () => {
  const d = dir();
  const jobs = [];
  const t = tools(d, { runJob: async (o) => { jobs.push(o); return `Started job j1 (${o.name})`; } });
  assert.strictEqual((await t.call('Bash', { command: 'pwd' })).text, d);
  const r = await t.call('Bash', { command: 'echo out; echo err 1>&2; exit 3' });
  assert.strictEqual(r.text, 'Error (exit 3): out\nerr');
  assert.match((await t.call('Bash', { command: 'sleep 3', timeout: 300 })).text, /timed out after 1000 ms/, 'timeouts have a 1 s floor');
  const big = await t.call('Bash', { command: 'yes abcdefghij | head -c 200000' });
  assert.ok(big.text.length < 31000 && /characters omitted/.test(big.text));
  assert.strictEqual((await t.call('Bash', { command: 'true' })).text, '(no output)');
  assert.match((await t.call('Bash', { command: '   ' })).text, /command is empty/);
  const bg = await t.call('Bash', { command: 'sleep 100', run_in_background: true, description: 'long thing' });
  assert.strictEqual(bg.text, 'Started job j1 (sleep 100)');
  assert.deepStrictEqual(jobs[0], { name: 'sleep 100', command: 'sleep 100', cwd: d });
  const noJobs = tools(d);
  assert.match((await noJobs.call('Bash', { command: 'x', run_in_background: true })).text, /not available here/);
  assert.strictEqual(cutOutput('abc', 10), 'abc');
});

test('sandbox: Bash runs through the box, file tools stay inside the mounts, Glob/Grep paths too', async () => {
  const d = dir();
  const calls = [];
  const t = createHubTools({ cwd: path.join(d, 'src'), sandbox: { mounts: [path.join(d, 'src')], exec: async (cmd, o) => { calls.push({ cmd, o }); return { stdout: 'in box\n', stderr: 'warn', code: 2 }; } }, log: () => {} });
  assert.ok(t.sandboxed);
  const r = await t.call('Bash', { command: 'ls', timeout: 5000 });
  assert.strictEqual(r.text, 'in box\n[stderr]\nwarn\n[exit code 2]');
  assert.deepStrictEqual(calls[0], { cmd: 'ls', o: { timeoutMs: 5000, cwd: path.join(d, 'src') } });
  assert.match((await t.call('Read', { file_path: path.join(d, 'a.txt') })).text, /not available inside this agent's sandbox/);
  assert.match((await t.call('Read', { file_path: '/etc/passwd' })).text, /not available inside/);
  assert.match((await t.call('Write', { file_path: path.join(d, 'x.txt'), content: 'x' })).text, /not available inside/);
  assert.match((await t.call('Glob', { pattern: '*', path: d })).text, /not available inside/);
  assert.match((await t.call('Grep', { pattern: 'a', path: d })).text, /not available inside/);
  assert.match((await t.call('Read', { file_path: 'b.js' })).text, /function beta/, 'relative paths resolve against the box cwd');
  assert.match((await t.call('Read', { file_path: path.join(d, 'src', '..', 'a.txt') })).text, /not available inside/, 'no escaping with ..');

  // R1: a symlink planted inside the box must not be followed out to a host file.
  fs.mkdirSync(path.join(d, 'outside'), { recursive: true });
  fs.writeFileSync(path.join(d, 'outside', 'secret.txt'), 'TOPSECRET');
  fs.symlinkSync(path.join(d, 'outside', 'secret.txt'), path.join(d, 'src', 'leak.txt'));
  fs.symlinkSync(path.join(d, 'outside'), path.join(d, 'src', 'out'));
  assert.match((await t.call('Read', { file_path: path.join(d, 'src', 'leak.txt') })).text, /not available inside/, 'read through a symlink to a host file is refused');
  assert.match((await t.call('Write', { file_path: path.join(d, 'src', 'out', 'new.txt'), content: 'x' })).text, /not available inside/, 'write through a symlinked dir is refused');
  assert.ok(!fs.existsSync(path.join(d, 'outside', 'new.txt')), 'nothing was written outside the box');
  fs.writeFileSync(path.join(d, 'src', 'normal.txt'), 'hi');
  const g = (await t.call('Glob', { pattern: '*.txt' })).text;
  assert.ok(g.includes('normal.txt'), 'a real file inside the box is listed');
  assert.ok(!g.includes('leak.txt'), 'a symlink that escapes the box is not listed');
  // A symlink that stays inside the box still works (the feature is not broken).
  fs.writeFileSync(path.join(d, 'src', 'real.txt'), 'REALDATA');
  fs.symlinkSync(path.join(d, 'src', 'real.txt'), path.join(d, 'src', 'alias.txt'));
  assert.match((await t.call('Read', { file_path: path.join(d, 'src', 'alias.txt') })).text, /REALDATA/, 'a symlink that stays inside the box still reads');
  // A dangling symlink (its target does not exist yet) must also be refused: a write through it would create a host file.
  fs.symlinkSync(path.join(d, 'outside', 'notyet.txt'), path.join(d, 'src', 'dangling.txt'));
  assert.match((await t.call('Write', { file_path: path.join(d, 'src', 'dangling.txt'), content: 'x' })).text, /not available inside/, 'write through a dangling symlink to outside is refused');
  assert.ok(!fs.existsSync(path.join(d, 'outside', 'notyet.txt')), 'the dangling target was not created outside the box');
  // Nested: a path through a symlinked directory to a not-yet-created outside file is refused too.
  fs.symlinkSync(path.join(d, 'outside'), path.join(d, 'src', 'outdir'));
  assert.match((await t.call('Write', { file_path: path.join(d, 'src', 'outdir', 'nested.txt'), content: 'x' })).text, /not available inside/, 'write through a symlinked directory is refused');
  assert.ok(!fs.existsSync(path.join(d, 'outside', 'nested.txt')), 'the nested target was not created outside the box');
});

test('unknown tools and thrown errors become text, never exceptions', async () => {
  const t = tools(dir());
  assert.match((await t.call('Nope', {})).text, /unknown tool/);
  assert.match((await t.call('Read', {})).text, /a path is required/);
});
