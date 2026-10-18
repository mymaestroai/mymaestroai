'use strict';
// Behavioural unit tests for lib/openai-responses.js: chat-completions <-> Responses API translation.
// Pure module: no network, no files. Streams are fed from in-memory SSE text through a real Response/ReadableStream.
const test = require('node:test');
const assert = require('node:assert');
const { toResponsesBody, fromResponsesJSON, wrapResponsesStream } = require('../lib/openai-responses');

// ── Request translation ─────────────────────────────────────────────────

test('toResponsesBody: system/developer merged into instructions, roles and parts converted', () => {
  const out = toResponsesBody({ model: 'gpt-5.6-cyber', messages: [
    { role: 'system', content: 'S1' },
    { role: 'developer', content: [{ type: 'text', text: 'D1' }, { type: 'text' }] },
    { role: 'user', content: [{ type: 'text', text: 'see' }, null, { type: 'image_url', image_url: { url: 'http://i/x.png', detail: 'high' } },
                              { type: 'image_url', image_url: 'http://i/y.png' }, { type: 'image_url', image_url: {} }, { type: 'weird' }] },
    { role: 'assistant', content: 'A' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }, { id: 'c2', function: { name: 'g' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'r1' },
    { role: 'tool', tool_call_id: 'c2', content: { k: 1 } },
    { role: 'user', content: '' }, { role: 'user', content: null },
  ] });
  assert.strictEqual(out.model, 'gpt-5.6-cyber');
  assert.strictEqual(out.store, false);
  assert.strictEqual(out.instructions, 'S1\n\nD1\n');
  assert.deepStrictEqual(out.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'see' }, { type: 'input_image', image_url: 'http://i/x.png', detail: 'high' },
                              { type: 'input_image', image_url: 'http://i/y.png', detail: 'auto' }] },
    { role: 'assistant', content: [{ type: 'output_text', text: 'A' }] },
    { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{"a":1}' },
    { type: 'function_call', call_id: 'c2', name: 'g', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: 'r1' },
    { type: 'function_call_output', call_id: 'c2', output: '{"k":1}' },
    { role: 'user', content: [{ type: 'input_text', text: '' }] },   // '' is kept (only null content is dropped)
  ]);
  assert.deepStrictEqual(out.reasoning, { summary: 'auto' });
  assert.strictEqual(out.stream, undefined);
  assert.strictEqual('instructions' in toResponsesBody({ model: 'm', messages: [{ role: 'user', content: 'x' }] }), false);
});

test('toResponsesBody: tools, tool_choice, sampling params, max tokens floor at 512, reasoning effort, stream', () => {
  const out = toResponsesBody({ model: 'm', messages: [], stream: true, temperature: 0.2, top_p: 0.9, parallel_tool_calls: false,
    reasoning_effort: 'high', max_tokens: 20,
    tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object', properties: { a: {} } } } },
            { type: 'function', function: { name: 'g' } }, { type: 'web_search_preview' }],
    tool_choice: { type: 'function', function: { name: 'f' } } });
  assert.deepStrictEqual(out.tools, [
    { type: 'function', name: 'f', description: 'd', parameters: { type: 'object', properties: { a: {} } } },
    { type: 'function', name: 'g', description: '', parameters: { type: 'object', properties: {} } },
    { type: 'web_search_preview' }]);
  assert.deepStrictEqual(out.tool_choice, { type: 'function', name: 'f' });
  assert.strictEqual(out.parallel_tool_calls, false);
  assert.strictEqual(out.max_output_tokens, 512);
  assert.strictEqual(out.temperature, 0.2); assert.strictEqual(out.top_p, 0.9);
  assert.deepStrictEqual(out.reasoning, { effort: 'high', summary: 'auto' });
  assert.strictEqual(out.stream, true);
  // precedence max_output_tokens > max_completion_tokens > max_tokens; string tool_choice passes through; empty tools dropped
  assert.strictEqual(toResponsesBody({ messages: [], max_tokens: 1000, max_completion_tokens: 900, max_output_tokens: 800 }).max_output_tokens, 800);
  assert.strictEqual(toResponsesBody({ messages: [], max_completion_tokens: 900, max_tokens: 1000 }).max_output_tokens, 900);
  const bare = toResponsesBody({ messages: [], tools: [], tool_choice: 'required' });
  assert.strictEqual(bare.tools, undefined); assert.strictEqual(bare.tool_choice, 'required');
  assert.strictEqual(toResponsesBody({ messages: [], tool_choice: { type: 'function' } }).tool_choice, undefined);
  assert.strictEqual(toResponsesBody({ messages: [] }).max_output_tokens, undefined);
});

// ── Response translation ────────────────────────────────────────────────

test('fromResponsesJSON: text + function calls -> tool_calls finish, usage extracted', () => {
  const out = fromResponsesJSON({ id: 'resp_1', created_at: 1700000000, model: 'gpt-5.6-cyber', status: 'completed', output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', content: [{ type: 'output_text', text: 'Hel' }, { type: 'output_text', text: 'lo' }] },
    { type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{"x":1}' },
    { type: 'function_call', call_id: 'call_2', name: 'g' },
  ], usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } } });
  assert.deepStrictEqual(out, { id: 'resp_1', object: 'chat.completion', created: 1700000000, model: 'gpt-5.6-cyber',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello', tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } },
      { id: 'call_2', type: 'function', function: { name: 'g', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 3 },
             completion_tokens_details: { reasoning_tokens: 2 }, cache_read_tokens: 3 } });
  assert.strictEqual(fromResponsesJSON({ output: [{ type: 'message', content: [] }], usage: { total_tokens: 7 } }).usage.total_tokens, 7);
});

test('fromResponsesJSON: empty content is null, refusal and incomplete map to finish reasons, no usage -> undefined', () => {
  const empty = fromResponsesJSON({ id: 'r', output: [] });
  assert.strictEqual(empty.choices[0].message.content, null);
  assert.strictEqual(empty.choices[0].message.tool_calls, undefined);
  assert.strictEqual(empty.choices[0].finish_reason, 'stop');
  assert.strictEqual(empty.usage, undefined);
  const ref = fromResponsesJSON({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }, { type: 'refusal', refusal: 'pe' }] }] });
  assert.strictEqual(ref.choices[0].message.refusal, 'nope');
  assert.strictEqual(ref.choices[0].finish_reason, 'content_filter');
  const fr = (status, reason) => fromResponsesJSON({ status, incomplete_details: { reason }, output: [] }).choices[0].finish_reason;
  assert.strictEqual(fr('incomplete', 'max_output_tokens'), 'length');
  assert.strictEqual(fr('incomplete', 'content_filter'), 'content_filter');
  assert.strictEqual(fr('incomplete', 'other'), 'stop');
  const incTool = fromResponsesJSON({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'function_call', call_id: 'c', name: 'f' }] });
  assert.strictEqual(incTool.choices[0].finish_reason, 'length', 'incomplete wins over tool_calls');
});

// ── Streaming translation ───────────────────────────────────────────────

const sse = (events) => events.map(e => (typeof e === 'string' ? e : `data: ${JSON.stringify(e)}`)).join('\n') + '\n';
function upstream(text, chunkSize = 7) {
  const enc = new TextEncoder(); let i = 0;
  return { body: new ReadableStream({ pull(c) { if (i >= text.length) return c.close(); c.enqueue(enc.encode(text.slice(i, i + chunkSize))); i += chunkSize; } }) };
}
async function collect(resp) {
  const text = await resp.text();
  const frames = text.split('\n\n').filter(Boolean);
  assert.ok(frames.every(f => f.startsWith('data: ')), text);
  return frames.map(f => f.slice(6)).map(f => (f === '[DONE]' ? f : JSON.parse(f)));
}

test('wrapResponsesStream: text, reasoning, tool-call delta assembly by item_id, usage frame, [DONE]', async () => {
  const text = sse([
    'event: response.created', { type: 'response.created', response: { id: 'resp_9', model: 'gpt-5.6-cyber' } }, '',
    { type: 'response.reasoning_summary_text.delta', delta: 'think' },
    { type: 'response.output_text.delta', delta: 'Hi ' }, { type: 'response.output_text.delta', delta: 'there' },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'f' } },
    { type: 'response.output_item.added', item: { type: 'message', id: 'msg_1' } },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'g' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '{"x"' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_b', delta: '{}' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_unknown', delta: 'zzz' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: ':1}' },
    'data: {broken json',
    { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 4, output_tokens: 6, input_tokens_details: { cached_tokens: 1 } } } },
    { type: 'response.output_text.delta', delta: 'AFTER-COMPLETED' },
  ]);
  const wrapped = wrapResponsesStream(upstream(text), 'fallback-model');
  assert.strictEqual(wrapped.status, 200);
  assert.strictEqual(wrapped.headers.get('content-type'), 'text/event-stream');
  const frames = await collect(wrapped);
  assert.strictEqual(frames.pop(), '[DONE]');
  const usage = frames.pop();
  assert.deepStrictEqual(usage, { id: 'resp_9', object: 'chat.completion.chunk', model: 'gpt-5.6-cyber', choices: [],
    usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10, prompt_tokens_details: { cached_tokens: 1 },
             completion_tokens_details: { reasoning_tokens: 0 }, cache_read_tokens: 1 } });
  assert.ok(frames.every(f => f.id === 'resp_9' && f.model === 'gpt-5.6-cyber' && f.object === 'chat.completion.chunk' && typeof f.created === 'number'));
  const deltas = frames.map(f => f.choices[0].delta);
  assert.deepStrictEqual(deltas, [
    { role: 'assistant', content: '' }, { reasoning_content: 'think' }, { content: 'Hi ' }, { content: 'there' },
    { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'f', arguments: '' } }] },
    { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'g', arguments: '' } }] },
    { tool_calls: [{ index: 0, function: { arguments: '{"x"' } }] },
    { tool_calls: [{ index: 1, function: { arguments: '{}' } }] },
    { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] },
    {},
  ]);
  assert.deepStrictEqual(frames.map(f => f.choices[0].finish_reason), [null, null, null, null, null, null, null, null, null, 'tool_calls']);
  // assembled arguments per tool call index, the way sdk-chat's tool loop concatenates them
  const args = {}; for (const d of deltas) for (const tc of d.tool_calls || []) args[tc.index] = (args[tc.index] || '') + tc.function.arguments;
  assert.deepStrictEqual(args, { 0: '{"x":1}', 1: '{}' });
});

test('wrapResponsesStream: refusal delta, incomplete -> length, no usage frame when usage missing', async () => {
  const text = sse([
    { type: 'response.created', response: {} },
    { type: 'response.refusal.delta', delta: 'cannot' },
    { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] } },
  ]);
  const frames = await collect(wrapResponsesStream(upstream(text, 1000), 'm'));
  assert.deepStrictEqual(frames.map(f => (f === '[DONE]' ? f : [f.id, f.model, f.choices[0].delta, f.choices[0].finish_reason])),
    [['resp', 'm', { role: 'assistant', content: '' }, null], ['resp', 'm', { refusal: 'cannot' }, null], ['resp', 'm', {}, 'length'], '[DONE]']);
  const refused = sse([{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'x' }] }] } }]);
  const f2 = await collect(wrapResponsesStream(upstream(refused), 'm'));
  assert.strictEqual(f2[0].choices[0].finish_reason, 'content_filter');
});

test('wrapResponsesStream: upstream ends without completed -> synthesized finish (tool_calls when a call was seen)', async () => {
  const plain = await collect(wrapResponsesStream(upstream(sse([{ type: 'response.output_text.delta', delta: 'partial' }])), 'm'));
  assert.deepStrictEqual(plain.map(f => (f === '[DONE]' ? f : f.choices[0].finish_reason)), [null, 'stop', '[DONE]']);
  const tc = await collect(wrapResponsesStream(upstream(sse([{ type: 'response.output_item.added', item: { type: 'function_call', id: 'i', call_id: 'c', name: 'f' } }])), 'm'));
  assert.deepStrictEqual(tc.map(f => (f === '[DONE]' ? f : f.choices[0].finish_reason)), [null, 'tool_calls', '[DONE]']);
  // a trailing line without newline is never parsed (buffer keeps it), so a lone unterminated completed event is ignored
  const unterminated = sse([{ type: 'response.output_text.delta', delta: 'a' }]) + 'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1}}}';
  const u = await collect(wrapResponsesStream(upstream(unterminated), 'm'));
  assert.strictEqual(u.length, 3, 'delta, synthesized stop, [DONE] (no usage frame)');
});

test('wrapResponsesStream: response.failed / error events reject the stream with the upstream message', async () => {
  for (const ev of [{ type: 'response.failed', response: { error: { message: 'quota' } } }, { type: 'error', error: { message: 'bad key' } }, { type: 'error', message: 'plain' }, { type: 'error' }]) {
    const expected = ev.response?.error?.message || ev.error?.message || ev.message || 'Responses API stream failed';
    const wrapped = wrapResponsesStream(upstream(sse([{ type: 'response.output_text.delta', delta: 'x' }, ev])), 'm');
    await assert.rejects(wrapped.text(), { message: `OpenAI responses: ${expected}` });
  }
});

test('wrapResponsesStream: cancelling the wrapped body cancels the upstream reader', async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } });
  const wrapped = wrapResponsesStream({ body }, 'm');
  await wrapped.body.cancel();
  assert.strictEqual(cancelled, true);
});
