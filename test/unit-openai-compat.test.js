'use strict';
// Behavioural unit tests for lib/openai-compat.js (/v1/chat/completions, /v1/models, /health).
// gateway-client is stubbed through require.cache; requests go through a loopback http server on an ephemeral port.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

process.env.MAX_BODY_SIZE = '2048';
const gw = { calls: [], reply: null, stream: null, models: ['claude-sdk/x', 'gpt-5'], hold: null };
const gwId = require.resolve('../lib/gateway-client');
require.cache[gwId] = { id: gwId, filename: gwId, loaded: true, exports: {
  chatCompletion: async (messages, opts) => { gw.calls.push({ messages, opts }); if (gw.hold) await gw.hold; if (gw.reply instanceof Error) throw gw.reply; if (gw.reply && '__throw' in gw.reply) throw gw.reply.__throw; return gw.reply; },
  chatCompletionStream: async (messages, opts) => { gw.calls.push({ messages, opts }); return { fake: true }; },
  parseSSEStream: async function* () { for (const c of gw.stream) yield c; },
  listModels: async () => { if (gw.models instanceof Error) throw gw.models; return gw.models; },
} };
const compat = require('../lib/openai-compat');

let server, base;
const handlerErrors = [];
const quiet = { log: console.log, error: console.error };
test.before(async () => {
  console.log = () => {}; console.error = () => {};
  server = http.createServer((req, res) => {
    if (req.url === '/v1/models') return compat.handleModels(req, res);
    if (req.url === '/health') return compat.handleHealth(req, res);
    compat.handleChatCompletion(req, res).catch(e => { handlerErrors.push({ err: e, headersSent: res.headersSent }); res.destroy(); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); console.log = quiet.log; console.error = quiet.error; });
test.beforeEach(() => { gw.calls.length = 0; gw.reply = null; gw.stream = null; gw.hold = null; handlerErrors.length = 0; });

const post = (body, opts = {}) => fetch(`${base}/v1/chat/completions`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), ...opts });

test('non-streaming: system merged, user text flattened, multipart user kept, gateway result passed through', async () => {
  gw.reply = { id: 'r1', choices: [{ message: { role: 'assistant', content: 'hi' } }] };
  const r = await post({ model: 'gpt-5', max_tokens: 9, temperature: 0.1, messages: [
    { role: 'system', content: 'A' }, { role: 'system', content: [{ type: 'text', text: 'B' }] },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }] },
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }, { type: 'other' }] },
  ] });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await r.json(), gw.reply);
  const { messages, opts } = gw.calls[0];
  assert.deepStrictEqual(messages, [
    { role: 'user', content: 'hello' }, { role: 'assistant', content: 'x\ny' },
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
  ]);
  assert.strictEqual(opts.system, 'A\nB');
  assert.strictEqual(opts.model, 'gpt-5'); assert.strictEqual(opts.max_tokens, 9); assert.strictEqual(opts.temperature, 0.1);
  assert.ok(opts.signal instanceof AbortSignal);
});

test('defaults model to claude-sonnet-4-6 and omits system when none given', async () => {
  gw.reply = { ok: 1 };
  await post({ messages: [{ role: 'user', content: 'q' }] });
  assert.strictEqual(gw.calls[0].opts.model, 'claude-sonnet-4-6');
  assert.strictEqual(gw.calls[0].opts.system, undefined);
});

test('malformed JSON body -> 400 JSON error, handler resolves (no hanging request)', async () => {
  const r = await post('{not json');
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.headers.get('content-type'), 'application/json');
  assert.match((await r.json()).error.message, /^Invalid JSON body/);
  assert.strictEqual(handlerErrors.length, 0);
  assert.strictEqual(gw.calls.length, 0);
});

test('body without a messages array -> 400, nothing sent to the gateway', async () => {
  for (const body of [{ model: 'gpt-5' }, { messages: 'hi' }, { messages: null }, 'null', '"str"']) {
    const r = await post(body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
    assert.deepStrictEqual(await r.json(), { error: { message: '"messages" must be an array' } });
  }
  assert.strictEqual(handlerErrors.length, 0);
  assert.strictEqual(gw.calls.length, 0);
});

test('assistant content:null + tool_calls and role:tool messages are folded into the conversation as text', async () => {
  gw.reply = { ok: 1 };
  const r = await post({ messages: [
    { role: 'user', content: 'run it' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'done' },
    { role: 'assistant', content: 'partial', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'g', arguments: '' } }] },
    { role: 'tool', content: [{ type: 'text', text: 'r2' }] },
    { role: 'assistant', content: null },
    { role: 'user', content: null },
  ] });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(gw.calls[0].messages, [
    { role: 'user', content: 'run it' },
    { role: 'assistant', content: '[tool call c1] f({"a":1})' },
    { role: 'user', content: '[tool result c1] done' },
    { role: 'assistant', content: 'partial\n[tool call c2] g()' },
    { role: 'user', content: '[tool result] r2' },
    { role: 'user', content: '' },
  ], 'empty assistant turn dropped; null user content becomes empty text');
  assert.strictEqual(handlerErrors.length, 0);
});

test('tools and tool_choice are accepted but unsupported: ignored, never a crash; junk entries in messages skipped', async () => {
  gw.reply = { ok: 1 };
  const r = await post({ messages: [
    { role: 'user', content: 'a' }, null, 7, { role: 'assistant', content: 'calling' }, { role: 'other', content: 'x' },
    { role: 'user', content: [{ type: 'text', text: 'b' }, 'junk', null] },
  ], tools: [{ type: 'function', function: { name: 'f' } }], tool_choice: 'required' });
  assert.strictEqual(r.status, 200);
  const { messages, opts } = gw.calls[0];
  assert.deepStrictEqual(messages, [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'calling' }, { role: 'user', content: 'b' }]);
  assert.strictEqual(opts.tools, undefined);
  assert.strictEqual(opts.tool_choice, undefined);
});

test('abort wiring: a client disconnect mid-call aborts the gateway signal; a normal completion does not (Node ' + process.version + ')', async () => {
  let release; gw.hold = new Promise(r => { release = r; }); gw.reply = { ok: 1 };
  const ac = new AbortController();
  const p = post({ messages: [{ role: 'user', content: 'slow' }] }, { signal: ac.signal }).catch(() => 'aborted');
  while (gw.calls.length === 0) await new Promise(r => setTimeout(r, 5));
  const { signal } = gw.calls[0].opts;
  assert.strictEqual(signal.aborted, false, 'no spurious abort right after body read');
  ac.abort();
  const t0 = Date.now(); while (!signal.aborted && Date.now() - t0 < 1000) await new Promise(r => setTimeout(r, 5));
  assert.strictEqual(signal.aborted, true, 'client disconnect aborted the gateway call');
  release(); assert.strictEqual(await p, 'aborted');
  gw.hold = null;
  const ok = await post({ messages: [{ role: 'user', content: 'fast' }] });
  assert.strictEqual(ok.status, 200); await ok.json();
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(gw.calls[1].opts.signal.aborted, false, 'normal completion never aborts');
});

test('a non-Error throw inside the handler still yields 500 JSON, never a hanging request', async () => {
  gw.reply = { __throw: 'raw failure' };
  const r = await post({ messages: [{ role: 'user', content: 'x' }] });
  assert.strictEqual(r.status, 500);
  assert.deepStrictEqual(await r.json(), { error: { message: 'raw failure' } });
  gw.reply = { __throw: null };
  const n = await post({ messages: [{ role: 'user', content: 'x' }] });
  assert.strictEqual(n.status, 500);
  assert.strictEqual(handlerErrors.length, 0);
});

test('streaming: content and finish chunks as chat.completion.chunk SSE, then [DONE]', async () => {
  gw.stream = [{ choices: [{ delta: { content: 'He' } }] }, { choices: [] }, { choices: [{ delta: { content: 'y' }, finish_reason: 'stop' }] }];
  const r = await post({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'text/event-stream');
  const frames = (await r.text()).split('\n\n').filter(Boolean).map(f => f.slice(6));
  assert.strictEqual(frames.pop(), '[DONE]');
  const objs = frames.map(f => JSON.parse(f));
  assert.deepStrictEqual(objs.map(o => o.choices[0].delta.content), ['He', 'y', undefined]);
  assert.deepStrictEqual(objs.map(o => o.choices[0].finish_reason), [null, null, 'stop']);
  assert.ok(objs.every(o => o.object === 'chat.completion.chunk' && o.model === 'm' && /^chatcmpl-\d+$/.test(o.id)));
});

test('gateway failure: 500 JSON when nothing sent yet; error frame + [DONE] mid-stream', async () => {
  gw.reply = new Error('upstream down');
  const r = await post({ messages: [{ role: 'user', content: 'x' }] });
  assert.strictEqual(r.status, 500);
  assert.deepStrictEqual(await r.json(), { error: { message: 'upstream down' } });
  gw.stream = { [Symbol.iterator]: function* () { yield { choices: [{ delta: { content: 'a' } }] }; throw new Error('mid'); } };
  const s = await post({ stream: true, messages: [{ role: 'user', content: 'x' }] });
  assert.strictEqual(s.status, 200);
  const frames = (await s.text()).split('\n\n').filter(Boolean);
  assert.deepStrictEqual(JSON.parse(frames[1].slice(6)), { error: { message: 'mid', type: 'server_error' } });
  assert.strictEqual(frames[2], 'data: [DONE]');
});

test('oversized body (MAX_BODY_SIZE env) is refused with 413 or a dropped connection', async () => {
  const out = await post({ messages: [{ role: 'user', content: 'x'.repeat(3000) }] }).then(r => r.status, () => 'conn-error');
  assert.ok(out === 413 || out === 'conn-error', String(out));
  assert.strictEqual(gw.calls.length, 0);
});

test('handleModels shape and failure; handleHealth', async () => {
  const r = await fetch(`${base}/v1/models`);
  assert.deepStrictEqual(await r.json(), { object: 'list', data: [
    { id: 'claude-sdk/x', object: 'model', owned_by: 'agent-hub' }, { id: 'gpt-5', object: 'model', owned_by: 'agent-hub' }] });
  gw.models = new Error('no gateway');
  const f = await fetch(`${base}/v1/models`);
  assert.strictEqual(f.status, 500);
  assert.deepStrictEqual(await f.json(), { error: { message: 'no gateway' } });
  const h = await fetch(`${base}/health`);
  assert.strictEqual(h.headers.get('content-type'), 'application/json');
  assert.deepStrictEqual(await h.json(), { status: 'ok', gateway: 'multi-provider', version: '5.0.0' });
});
