'use strict';
// anthropic/ (API key) route: OpenAI-format history with tool calls is converted to Anthropic Messages format,
// and the streamed reply reports token usage. Before this, the second model call of any tool-using turn failed
// with 400 "Unexpected role \"tool\"" and the ledger booked these turns at $0 (reported by a tester).
const test = require('node:test');
const assert = require('node:assert');
const log = console.log; console.log = () => {};
const gw = require('../lib/gateway-client');
console.log = log;

test('assistant tool_calls -> tool_use blocks; tool results -> one user message of tool_result blocks', () => {
  const out = gw.convertToAnthropicMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'weather in Paris and Rome?' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'tu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
      { id: 'tu_2', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Rome"}' } }] },
    { role: 'tool', tool_call_id: 'tu_1', content: 'Sunny' },
    { role: 'tool', tool_call_id: 'tu_2', content: '' },
    { role: 'user', content: '[hub note after the tool batch]' },
    { role: 'assistant', content: 'Both sunny.' },
  ]);
  assert.deepStrictEqual(out.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepStrictEqual(out[1].content, [
    { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } },
    { type: 'tool_use', id: 'tu_2', name: 'get_weather', input: { city: 'Rome' } }]);
  assert.deepStrictEqual(out[2].content.map(b => b.type), ['tool_result', 'tool_result', 'text'], 'results lead, the note follows');
  assert.strictEqual(out[2].content[0].tool_use_id, 'tu_1');
  assert.deepStrictEqual(out[2].content[0].content, [{ type: 'text', text: 'Sunny' }]);
  assert.deepStrictEqual(out[2].content[1].content, [{ type: 'text', text: '(no output)' }], 'empty result still answers the call');
  assert.ok(!JSON.stringify(out).includes('"role":"tool"'));
});

test('text before a tool call stays; images in results and user turns become image blocks; bad JSON args survive', () => {
  const img = 'data:image/png;base64,AAAA';
  const out = gw.convertToAnthropicMessages([
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: img } }] },
    { role: 'assistant', content: 'Let me check.', tool_calls: [{ id: 'a', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/x' } }] },
    { role: 'tool', tool_call_id: 'a', content: [{ type: 'text', text: 'page' }, { type: 'image_url', image_url: { url: img } }] },
  ]);
  assert.deepStrictEqual(out[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  assert.deepStrictEqual(out[1].content.map(b => b.type), ['text', 'tool_use']);
  assert.deepStrictEqual(out[1].content[1].input, { _raw: '{"file_path":"/x' });
  assert.deepStrictEqual(out[2].content[0].content.map(b => b.type), ['text', 'image']);
});

test('a tool call left without a result is answered as not run; history never starts with the assistant', () => {
  const out = gw.convertToAnthropicMessages([
    { role: 'assistant', content: 'earlier', tool_calls: [{ id: 'z', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
    { role: 'user', content: 'next question' },
  ]);
  assert.deepStrictEqual(out.map(m => m.role), ['user', 'assistant', 'user']);
  assert.strictEqual(out[2].content[0].type, 'tool_result');
  assert.strictEqual(out[2].content[0].tool_use_id, 'z');
  assert.strictEqual(out[2].content[0].is_error, true);
  assert.strictEqual(out[2].content[1].text, 'next question');
});

test('consecutive same-role messages merge; empty text is dropped', () => {
  const out = gw.convertToAnthropicMessages([
    { role: 'user', content: 'a' }, { role: 'user', content: '' }, { role: 'user', content: 'b' },
    { role: 'assistant', content: '' }, { role: 'assistant', content: 'c' },
  ]);
  assert.deepStrictEqual(out, [
    { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'c' }] }]);
});

test('the stream adapter emits usage (input incl. cache, output) and maps max_tokens to length', async () => {
  const sse = [
    { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 42 } },
    { type: 'message_stop' },
  ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  const upstream = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } }), { status: 200 });
  const chunks = [];
  for await (const c of gw.parseSSEStream(gw.createAnthropicStreamAdapter(upstream), {})) chunks.push(c);
  assert.strictEqual(chunks.find(c => c.choices?.[0]?.finish_reason).choices[0].finish_reason, 'length');
  const u = chunks.find(c => c.usage).usage;
  assert.deepStrictEqual(u, { prompt_tokens: 160, completion_tokens: 42, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 });
});

test('OpenAI and Google streams ask for usage; the gateway loop books provider tokens in the ledger', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'gateway-client.js'), 'utf8');
  assert.match(src, /const STREAM_USAGE_PROVIDERS = new Set\(\['openai', 'google'\]\);/);
  assert.match(src, /body\.stream_options = \{ include_usage: true \}/);
  const chat = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(chat, /if \(chunk\.usage && typeof chunk\.usage === 'object'\) callUsage = chunk\.usage;/);
  assert.match(chat, /turnUsage\.input \+= inT; turnUsage\.output \+= outT; turnUsage\.seen = true;/);
  assert.match(chat, /\.\.\.\(turnUsage\.seen \? \{ inputTokens: turnUsage\.input, outputTokens: turnUsage\.output, cacheRead: turnUsage\.cacheRead, cacheWrite: turnUsage\.cacheWrite \} : \{\}\)/);
});

test('a chat turn for an agent that does not exist is refused with 404, not run on a default model', async () => {
  const sdkChat = require('../lib/sdk-chat');
  let status, body;
  await sdkChat.handleChatStream({ agent: 'zz_no_such_agent_404', message: 'hi' },
    { writableEnded: false, destroyed: false, on() {}, writeHead(s) { status = s; }, write() { return true; }, end(d) { body = d; this.writableEnded = true; } });
  assert.strictEqual(status, 404);
  assert.match(JSON.parse(body).error, /No agent named "zz_no_such_agent_404"/);
});
