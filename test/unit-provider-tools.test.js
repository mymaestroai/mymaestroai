'use strict';
// Behavioural tests for lib/provider-tools.js. File handlers run on a temp dir; lib/task-queue.js (SQLite + hub HTTP) is stubbed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-ptools-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const created = [];
const TQ = require.resolve('../lib/task-queue.js');
require.cache[TQ] = { id: TQ, filename: TQ, loaded: true, exports: {
  createTask: (t) => { created.push(t); return { id: created.length, ...t }; },
  listTasks: (f) => (f && f.status === 'none' ? [] : [{ id: 1 }]),
  cancelTask: (id) => id === 1,
} };
const { BUILTIN_TOOLS, executeToolCall, builtinToolToOpenAI } = require('../lib/provider-tools.js');
const artifacts = require('../lib/tiger-team-artifacts.js');
const H = (name) => BUILTIN_TOOLS[name].handler;
const call = (name, args, handlers) => executeToolCall({ function: { name, arguments: JSON.stringify(args) } }, handlers || new Map([[name, H(name)]]));
const f = (n) => path.join(TMP, n);

test('26 built-in tools, each a well-formed function-calling definition', () => {
  const names = Object.keys(BUILTIN_TOOLS);
  assert.strictEqual(names.length, 26);
  for (const n of ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'RestartHub', 'create_task', 'list_tasks', 'cancel_task',
    'request_additional_rounds', 'start_tiger_team', 'request_tools', 'auth_http_status', 'auth_http_request']) assert.ok(names.includes(n), n);
  for (const [n, d] of Object.entries(BUILTIN_TOOLS)) {
    assert.match(n, /^[A-Za-z0-9_-]{1,64}$/, n);
    assert.strictEqual(typeof d.description, 'string', n);
    assert.strictEqual(typeof d.handler, 'function', n);
    assert.strictEqual(d.parameters.type, 'object', n);
    assert.strictEqual(typeof d.parameters.properties, 'object', n);
    for (const r of d.parameters.required || []) assert.ok(r in d.parameters.properties, `${n}.required has unknown property ${r}`);
  }
  assert.deepStrictEqual(BUILTIN_TOOLS.Edit.parameters.required, ['file_path', 'old_string', 'new_string']);
  assert.deepStrictEqual(BUILTIN_TOOLS.Bash.parameters.required, ['command']);
});

test('builtinToolToOpenAI wraps name/description/parameters', () => {
  const t = builtinToolToOpenAI('Read', BUILTIN_TOOLS.Read);
  assert.deepStrictEqual(t, { type: 'function', function: { name: 'Read', description: BUILTIN_TOOLS.Read.description, parameters: BUILTIN_TOOLS.Read.parameters } });
  assert.deepStrictEqual(Object.keys(builtinToolToOpenAI('x', { description: 'd', parameters: {}, handler() {} }).function), ['name', 'description', 'parameters']);
});

test('executeToolCall: unknown tool, bad JSON, empty args, object result, thrown error', async () => {
  const h = new Map([['echo', async (a) => a], ['str', async () => 'plain'], ['boom', async () => { throw new Error('kaput'); }], ['n', async (a) => Object.keys(a).length]]);
  assert.strictEqual(await executeToolCall({ function: { name: 'nope', arguments: '{}' } }, h), 'Error: Unknown tool "nope"');
  assert.strictEqual(await executeToolCall({}, h), 'Error: Unknown tool "undefined"');
  assert.match(await executeToolCall({ function: { name: 'echo', arguments: '{bad' } }, h), /^Error parsing arguments for echo: /);
  assert.strictEqual(await executeToolCall({ function: { name: 'n', arguments: '' } }, h), '0');
  assert.strictEqual(await executeToolCall({ function: { name: 'echo', arguments: '{"a":[1,2]}' } }, h), '{"a":[1,2]}');
  assert.strictEqual(await executeToolCall({ function: { name: 'str', arguments: '{}' } }, h), 'plain');
  assert.strictEqual(await executeToolCall({ function: { name: 'boom', arguments: '{}' } }, h), 'Error executing boom: kaput');
});

test('TT_PERSISTENCE_FAILED is rethrown by executeToolCall and by the Read/Edit/Bash handlers; plain errors are not', async () => {
  const bad = { preserve() { throw new Error('disk full'); } };
  await fs.promises.writeFile(f('tt.txt'), 'x\n');
  for (const [name, args] of [['Read', { file_path: f('tt.txt') }], ['Edit', { file_path: f('tt.txt'), old_string: 'x', new_string: 'y' }], ['Bash', { command: 'echo hi' }]]) {
    await assert.rejects(() => artifacts.run(bad, () => call(name, args)), (e) => e.code === 'TT_PERSISTENCE_FAILED' && /disk full/.test(e.message), name);
  }
  const h = new Map([['t', async () => { throw Object.assign(new Error('x'), { code: 'TT_PERSISTENCE_FAILED' }); }], ['o', async () => { throw Object.assign(new Error('x'), { code: 'EOTHER' }); }]]);
  await assert.rejects(() => executeToolCall({ function: { name: 't', arguments: '{}' } }, h), { code: 'TT_PERSISTENCE_FAILED' });
  assert.match(await executeToolCall({ function: { name: 'o', arguments: '{}' } }, h), /^Error executing o/);
  assert.strictEqual(await artifacts.run({ preserve() {} }, () => call('Bash', { command: 'echo ok' })), 'ok');
});

test('Read: numbered lines, offset/limit, long-line and missing-file handling', async () => {
  fs.writeFileSync(f('r.txt'), 'a\nb\nc\nd');
  assert.strictEqual(await call('Read', { file_path: f('r.txt') }), '     1\ta\n     2\tb\n     3\tc\n     4\td');
  assert.strictEqual(await call('Read', { file_path: f('r.txt'), offset: 2, limit: 2 }), '     2\tb\n     3\tc\n\n(1 more line(s); continue with offset: 4)');
  assert.strictEqual(await call('Read', { file_path: f('r.txt'), offset: 3 }), '     3\tc\n     4\td');
  assert.strictEqual(await call('Read', { file_path: f('r.txt'), offset: 0, limit: 1 }), '     1\ta\n\n(3 more line(s); continue with offset: 2)');
  fs.writeFileSync(f('long.txt'), 'x'.repeat(2500));
  assert.strictEqual(await call('Read', { file_path: f('long.txt') }), `     1\t${'x'.repeat(2000)}…`);
  fs.writeFileSync(f('huge.txt'), ('y'.repeat(1000) + '\n').repeat(100));
  const big = await call('Read', { file_path: f('huge.txt') });
  assert.ok(big.endsWith('\n(use offset and limit to read the rest)'));
  assert.ok(big.length < 61000 && big.includes('characters omitted'));
  assert.match(await call('Read', { file_path: f('missing') }), /^Error: file not found: .*missing$/);
});

test('Write creates parent dirs, overwrites only what was read this turn, and reports failures as strings', async () => {
  const p = f('deep/er/w.txt');
  assert.strictEqual(await call('Write', { file_path: p, content: 'héllo' }), `Created ${p} (5 characters, 1 lines)`);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'héllo');
  assert.strictEqual(await call('Write', { file_path: p, content: 'z' }), `Updated ${p} (1 characters, 1 lines)`, 'a file this turn created counts as read');
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'z');
  fs.writeFileSync(f('unread.txt'), 'u');
  assert.match(await call('Write', { file_path: f('unread.txt'), content: 'x' }), /^Error: .*exists and has not been read this turn/);
  assert.match(await call('Write', { file_path: f('deep'), content: 'x' }), /^Error: /);
  assert.strictEqual(await call('Write', { file_path: f('nc.txt') }), 'Error: content is required');
});

test('Edit: read first, unique replace, not found, not unique, replace_all, missing file', async () => {
  const p = f('e.txt');
  fs.writeFileSync(p, 'one two one');
  assert.match(await call('Edit', { file_path: p, old_string: 'zzz', new_string: 'q' }), /^Error: .*has not been read this turn/);
  await call('Read', { file_path: p });
  assert.match(await call('Edit', { file_path: p, old_string: 'zzz', new_string: 'q' }), /^Error: old_string not found/);
  assert.match(await call('Edit', { file_path: p, old_string: 'one', new_string: 'q' }), /not unique/);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), 'one two one');
  assert.match(await call('Edit', { file_path: p, old_string: 'two', new_string: '2' }), new RegExp(`^Edited ${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. The region now reads:\\n     1\\tone 2 one$`));
  await call('Edit', { file_path: p, old_string: 'one', new_string: '1', replace_all: true });
  assert.strictEqual(fs.readFileSync(p, 'utf8'), '1 2 1');
  assert.match(await call('Edit', { file_path: f('nofile'), old_string: 'a', new_string: 'b' }), /^Error: file not found/);
});

test('Edit inserts new_string literally: "$&", "$1", "$$", "$`" are never expanded (with or without replace_all)', async () => {
  const p = f('dollar.txt');
  for (const [repl, all] of [['$&$&', false], ["$1 $$ $` $'", false], ['$&$&', true]]) {
    fs.writeFileSync(p, 'cost: X');
    await call('Read', { file_path: p });
    await call('Edit', { file_path: p, old_string: 'X', new_string: repl, replace_all: all });
    assert.strictEqual(fs.readFileSync(p, 'utf8'), `cost: ${repl}`);
  }
});

test('Bash: stdout, stderr appended, empty output, exit codes, TERM, truncation, timeout', async () => {
  assert.strictEqual(await call('Bash', { command: 'echo out; echo err >&2' }), 'out\nerr');
  assert.strictEqual(await call('Bash', { command: 'true' }), '(no output)');
  assert.strictEqual(await call('Bash', { command: 'echo $TERM' }), 'dumb');
  const fail = await call('Bash', { command: 'echo partial; exit 3' });
  assert.strictEqual(fail, 'Error (exit 3): partial');
  assert.strictEqual(await call('Bash', { command: 'echo oops >&2; exit 2' }), 'Error (exit 2): oops');
  const big = await call('Bash', { command: "head -c 40000 /dev/zero | tr '\\0' a" });
  assert.ok(big.length < 31000 && big.startsWith('a'.repeat(100)) && big.includes('[10000 characters omitted]'));
  assert.match(await call('Bash', { command: 'sleep 5', timeout: 1000 }), /^Error \(exit \?\): \[timed out after 1000 ms; the command and its children were killed\]/);
});

test('Glob: newest first, only files, no-match marker', async () => {
  const d = f('g'); fs.mkdirSync(path.join(d, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(d, 'old.txt'), '1'); fs.writeFileSync(path.join(d, 'new.txt'), '2'); fs.writeFileSync(path.join(d, 'sub', 'x.txt'), '3');
  const t = Date.now() / 1000;
  fs.utimesSync(path.join(d, 'old.txt'), t - 100, t - 100); fs.utimesSync(path.join(d, 'new.txt'), t, t);
  assert.strictEqual(await call('Glob', { pattern: '*.txt', path: d }), `${d}/new.txt\n${d}/old.txt`);
  assert.ok((await call('Glob', { pattern: '**/*.txt', path: d })).includes(`${d}/sub/x.txt`));
  assert.strictEqual(await call('Glob', { pattern: '*.md', path: d }), '(no matches)');
});

test('Grep: files-only, content mode, no-match marker (ripgrep or the Node fallback)', async () => {
  const d = f('gr'); fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'a.js'), 'needle\n'); fs.writeFileSync(path.join(d, 'b.md'), 'needle\n');
  assert.strictEqual(await call('Grep', { pattern: 'needle', path: d, glob: '*.js' }), `${d}/a.js`);
  assert.match(await call('Grep', { pattern: 'needle', path: d, glob: '*.md', output_mode: 'content' }), /b\.md:1:needle/);
  assert.strictEqual(await call('Grep', { pattern: 'absent', path: d }), '(no matches)');
});

test('create_task: executeToolCall passes no context, so a raw registration records creator "unknown"; the sdk-chat wrapper supplies the agent', async () => {
  const args = { target_agent: 'cos', trigger_type: 'delay', trigger_value: '5', action_prompt: 'ping' };
  await call('create_task', args);
  // Suspected bug (executeToolCall calls handler(args) with no context): CONFIRMED at this layer.
  assert.strictEqual(created.at(-1).creator_agent, 'unknown');
  // REFUTED for production wiring: lib/sdk-chat.js registers create_task as (args) => def.handler(args, { agentName }).
  await call('create_task', args, new Map([['create_task', (a) => BUILTIN_TOOLS.create_task.handler(a, { agentName: 'maestro' })]]));
  assert.strictEqual(created.at(-1).creator_agent, 'maestro');
  assert.deepStrictEqual([created.at(-1).target_agent, created.at(-1).trigger_type, created.at(-1).trigger_value], ['cos', 'delay', '5']);
});

test('list_tasks / cancel_task / not-injected placeholders', async () => {
  assert.strictEqual(await call('list_tasks', { status: 'none' }), 'No tasks found.');
  assert.deepStrictEqual(JSON.parse(await call('list_tasks', {})), [{ id: 1 }]);
  assert.strictEqual(await call('cancel_task', { task_id: 1 }), 'Task #1 cancelled.');
  assert.strictEqual(await call('cancel_task', { task_id: 9 }), 'Task #9 not found or not pending.');
  for (const n of ['request_additional_rounds', 'start_tiger_team', 'request_tools']) assert.match(await call(n, {}), /handler not injected/);
});
