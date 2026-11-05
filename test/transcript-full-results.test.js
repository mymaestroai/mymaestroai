'use strict';
// The conversation archive keeps a tool's whole output (up to its own 64 KB per entry), while the pages keep getting
// the short copy: each route hands the whole output to the recorder (res.archiveToolOutput) just before it sends the
// short tool_result event.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTranscript } = require('../lib/transcript');
const { SdkWorkerTracker, resultFull } = require('../lib/sdk-workers');
const codexCli = require('../lib/codex-cli');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-full-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sse = (ev) => `data: ${JSON.stringify({ gateway: ev })}\n\n`;
function fakeRes() { const written = []; return { written, write(chunk) { written.push(chunk); return true; } }; }
const rows = (tr, agent) => tr.search(agent, '', { kinds: ['tool_result'], limit: 100 }).reverse();
// the stored text itself (search and context return shortened copies)
const fullText = (tr, row) => { const Database = require('better-sqlite3'); const db = new Database(tr.fileFor(row.agent), { readonly: true }); try { const r = db.prepare('SELECT text FROM entries WHERE id = ?').get(row.id); return r ? r.text : null; } finally { db.close(); } };

test('the archive keeps the whole output a turn hands over; the page still gets the short copy', () => {
  const tr = createTranscript({ file: path.join(tmp, 'a.db') });
  const res = fakeRes();
  const t = tr.tap(res, { agent: 'zz_full', turnId: 't1' });
  const whole = 'word '.repeat(4000);                       // 20,000 characters
  res.archiveToolOutput('call-1', whole);
  const short = whole.slice(0, 2000) + '...';
  res.write(sse({ type: 'tool_result', tool_call_id: 'call-1', output: short }));
  res.write(sse({ type: 'tool_result', tool_call_id: 'call-2', output: 'no whole output handed over' }));
  t.finish(true);
  assert.ok(res.written[0].includes(short) && !res.written[0].includes(whole), 'the page got the short copy');
  const got = rows(tr, 'zz_full');
  assert.strictEqual(got.length, 2);
  assert.strictEqual(fullText(tr, got[0]), whole, 'the archive kept the whole output');
  assert.strictEqual(fullText(tr, got[1]), 'no whole output handed over', 'without a whole output the event is kept as before');
  assert.strictEqual(res.archiveToolOutput, undefined, 'the hand-over ends with the turn');
  tr.close();
});

test('an output beyond 64 KB keeps its beginning and end; a detached turn (page closed) is archived the same way', () => {
  const tr = createTranscript({ file: path.join(tmp, 'b.db') });
  const res = fakeRes();
  const t = tr.tap(res, { agent: 'zz_full2' });
  const huge = 'BEGIN ' + 'x'.repeat(200000) + ' END';
  res.archiveToolOutput('c1', huge);
  res.observeClosed({ gateway: { type: 'tool_result', tool_call_id: 'c1', output: huge.slice(0, 2000) } });
  t.finish(true);
  const [row] = rows(tr, 'zz_full2');
  const text = fullText(tr, row);
  assert.ok(text.startsWith('BEGIN ') && text.endsWith(' END'), 'beginning and end kept');
  assert.ok(text.length < 70000 && text.includes('chars omitted'), 'clipped to the archive limit');
  tr.close();
});

test('the Claude route hands over the text the model read for that call, not the short JSON', () => {
  const tracker = new SdkWorkerTracker();
  const long = Array.from({ length: 400 }, (_, i) => `line ${i} of the build log`).join('\n');
  const msg = {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: long }] }] },
    tool_use_result: { stdout: long, stderr: '', interrupted: false },
  };
  const r = tracker.resolveResult(msg);
  assert.strictEqual(r.kind, 'top');
  assert.strictEqual(r.full, long, 'the whole text, with real newlines (searchable)');
  assert.ok(r.output.length <= 2000 && r.output.startsWith('{"stdout"'), 'the page form is unchanged');
  assert.strictEqual(resultFull({ tool_use_result: 'plain' }, null), 'plain');
});

test('the ChatGPT route hands over the whole command output and the whole tool reply', () => {
  const out = Array.from({ length: 600 }, (_, i) => `row ${i}`).join('\n');
  const cmd = { type: 'command_execution', aggregated_output: out, exit_code: 0 };
  assert.ok(codexCli.toolOutputOf(cmd).length <= 2000, 'the page form keeps the last 2,000 characters');
  assert.strictEqual(codexCli.toolFullOutputOf(cmd), out, 'the archive gets all of it');
  const failed = { type: 'command_execution', aggregated_output: out, exit_code: 2 };
  assert.ok(codexCli.toolFullOutputOf(failed).startsWith('exit 2\nrow 0'));
  const text = 'z'.repeat(9000);
  const mcp = { type: 'mcp_tool_call', result: { content: [{ type: 'text', text }] } };
  assert.strictEqual(codexCli.toolFullOutputOf(mcp), text);
  const events = codexCli.eventToActions({ type: 'item.completed', item: { id: 'it1', ...cmd } });
  const tr = events.find(a => a.kind === 'tool_result');
  assert.ok(tr && tr.full === out, 'the stream action carries the whole output');
});

test('every route hands the whole output over before it sends the short tool result', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  const handovers = (src.match(/res\.archiveToolOutput\?\.\(/g) || []).length;
  assert.ok(handovers >= 4, `Claude (completed and plain results), API-key and ChatGPT routes: found ${handovers}`);
  const app = fs.readFileSync(path.join(__dirname, '..', 'lib', 'codex-cli', 'app-server.js'), 'utf8');
  assert.match(app, /full: codexCli\.toolFullOutputOf\(it\)/, 'the Codex app-server stream carries the whole output too');
});

test('images are named, never archived as their data; failures and interruptions are kept with the text', () => {
  const tracker = new SdkWorkerTracker();
  const b64 = 'iVBORw0KGgo' + 'A'.repeat(50000);
  const img = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_img', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }] }] }, tool_use_result: { type: 'image', file: { base64: b64 } } };
  assert.strictEqual(tracker.resolveResult(img).full, '[image]');
  const noBlock = resultFull({ tool_use_result: { type: 'image', file: { base64: b64, type: 'image/png' } } }, null);
  assert.ok(!noBlock.includes('AAAA') && noBlock.includes('[binary data]'), 'base64 left out of the JSON form too');
  const failed = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_err', is_error: true, content: 'Error: no such file' }] }, tool_use_result: 'Error: no such file' };
  assert.deepStrictEqual(tracker.resolveResult(failed).meta, { is_error: true });
  const cut = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_int', content: 'partial output' }] }, tool_use_result: { stdout: 'partial output', interrupted: true } };
  assert.deepStrictEqual(tracker.resolveResult(cut).meta, { interrupted: true });
  // the tap keeps those flags with the row, and a hand-over that can't be read never throws
  const tr = createTranscript({ file: path.join(tmp, 'c.db') });
  const res = fakeRes();
  const t = tr.tap(res, { agent: 'zz_full3' });
  res.archiveToolOutput('e1', 'Error: no such file', { is_error: true });
  res.write(sse({ type: 'tool_result', tool_call_id: 'e1', output: 'Error: no such file' }));
  const loop = {}; loop.self = loop;
  assert.doesNotThrow(() => res.archiveToolOutput('e2', loop));
  t.finish(true);
  const Database = require('better-sqlite3');
  const db = new Database(tr.fileFor('zz_full3'), { readonly: true });
  const meta = JSON.parse(db.prepare("SELECT meta FROM entries WHERE agent = 'zz_full3' AND kind = 'tool_result'").get().meta);
  db.close();
  assert.deepStrictEqual(meta, { tool_call_id: 'e1', is_error: true });
  tr.close();
});

test('a ChatGPT-route tool reply keeps every kind of part as text, and failures are marked', () => {
  const mcp = { type: 'mcp_tool_call', result: {
    content: [{ type: 'text', text: 'first' }, { type: 'image', data: 'AAAA'.repeat(1000) }, { type: 'resource', resource: { uri: 'file:///notes.md', text: 'notes text' } }, { type: 'resource_link', uri: 'https://example.com/doc' }],
    structuredContent: { rows: 3 },
  } };
  assert.strictEqual(codexCli.toolFullOutputOf(mcp), 'first\n[image]\nnotes text\n[link https://example.com/doc]\n{"rows":3}');
  assert.strictEqual(codexCli.toolFailed({ type: 'command_execution', exit_code: 1 }), true);
  assert.strictEqual(codexCli.toolFailed({ type: 'command_execution', exit_code: 0 }), false);
  assert.strictEqual(codexCli.toolFailed({ type: 'mcp_tool_call', error: { message: 'x' } }), true);
});

test('only data that looks like base64 is left out, and a tool reply marked isError counts as failed', () => {
  const report = 'A plain report about the shed, the garden and the gate. '.repeat(10);
  assert.ok(resultFull({ tool_use_result: { data: report } }, null).includes('the shed, the garden'), 'ordinary text under "data" survives');
  assert.ok(resultFull({ tool_use_result: { data: 'QUJD'.repeat(100) } }, null).includes('[binary data]'));
  assert.strictEqual(codexCli.toolFailed({ type: 'mcp_tool_call', result: { isError: true, content: [{ type: 'text', text: 'Permission denied' }] } }), true);
  assert.strictEqual(codexCli.toolFailed({ type: 'mcp_tool_call', status: 'failed' }), true);
  assert.strictEqual(codexCli.toolFailed({ type: 'command_execution', exit_code: null }), false);
});
