'use strict';
// Claude on its API key while it thinks: Anthropic sends only a ping about every 30 s and hands over the whole
// thinking block at the end. The stream adapter must keep the hub's idle watchdog fed, pass Anthropic's own errors
// on, and the turn loop must give thinking room, stop instead of re-asking when thinking ate everything, and know
// Claude's real context window. (2026-10-18: Doc on anthropic/claude-fable-5-1 at effort max was cut off after
// 120 s of silence as "the model returned nothing", about every other turn.)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const gw = require('../lib/gateway-client');
const errorHelp = require('../lib/error-help');
const cb = require('../lib/context-budget');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// An upstream Anthropic SSE body: [delayMs, event] pairs, each sent after its delay.
function upstream(steps) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    async start(c) {
      for (const [ms, ev] of steps) {
        if (ms) await new Promise(r => setTimeout(r, ms));
        c.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
      }
      c.close();
    },
  }), { status: 200 });
}

const THINKING_THEN_ANSWER = (pings, every) => [
  [0, { type: 'message_start', message: { usage: { input_tokens: 61, output_tokens: 1 } } }],
  [0, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
  ...Array.from({ length: pings }, () => [every, { type: 'ping' }]),
  [every, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'long think' } }],
  [0, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }],
  [0, { type: 'content_block_stop', index: 0 }],
  [0, { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
  [0, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } }],
  [0, { type: 'content_block_stop', index: 1 }],
  [0, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 900 } }],
  [0, { type: 'message_stop' }],
];

async function collect(res, st, stallMs) {
  Object.defineProperty(res, '__hubStallMs', { value: stallMs, enumerable: false, configurable: true });
  let text = ''; const chunks = [];
  for await (const c of gw.parseSSEStream(res, st)) { chunks.push(c); if (c.choices?.[0]?.delta?.content) text += c.choices[0].delta.content; }
  return { text, chunks };
}

test('thinking with only pings for longer than the watchdog no longer counts as silence', async () => {
  const st = {};
  // 6 pings 100 ms apart = 700 ms of thinking, against a 300 ms watchdog
  const { text, chunks } = await collect(gw.createAnthropicStreamAdapter(upstream(THINKING_THEN_ANSWER(6, 100))), st, 300);
  assert.strictEqual(st.stalled, false, 'the watchdog did not trip');
  assert.strictEqual(text, 'Answer');
  assert.strictEqual(chunks.find(c => c.choices?.[0]?.finish_reason).choices[0].finish_reason, 'stop');
  assert.ok(chunks.find(c => c.usage), 'usage still reported');
  assert.strictEqual(st.stallMs, 300, 'the window is recorded for the error message');
});

test('a stream that is really silent still trips the watchdog', async () => {
  const st = {};
  const silent = [[0, { type: 'message_start', message: { usage: { input_tokens: 5 } } }], [700, { type: 'message_stop' }]];
  const { text } = await collect(gw.createAnthropicStreamAdapter(upstream(silent)), st, 300);
  assert.strictEqual(st.stalled, true);
  assert.strictEqual(text, '');
});

test('the adapter passes a keep-alive comment for events with no output, and Anthropic errors as error chunks', async () => {
  const res = gw.createAnthropicStreamAdapter(upstream([
    [0, { type: 'message_start', message: { usage: { input_tokens: 5 } } }],
    [0, { type: 'ping' }],
    [0, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }],
  ]));
  const raw = await res.text();
  assert.strictEqual((raw.match(/^: keepalive$/gm) || []).length, 2, 'message_start and ping each pass a comment');
  assert.ok(raw.includes(`data: ${JSON.stringify({ error: { type: 'overloaded_error', message: 'Overloaded', provider: 'anthropic' } })}`));
});

test('the turn loop: provider errors in the stream, a stall message, room to think, and no paid re-asks after an empty think', () => {
  const sdk = read('lib/sdk-chat.js');
  assert.match(sdk, /if \(chunk\.error\) \{\s*const pe = chunk\.error;\s*const status = \{ overloaded_error: 529,[^\n]*\}\[pe\.type\] \|\| Number\(pe\.code\) \|\| 500;\s*const streamErr = new Error\(`Provider \$\{status\}: \$\{JSON\.stringify\(\{ error: pe \}\)\}`\);/);
  assert.match(sdk, /if \(streamState\.stalled\) throw new Error\(`No data from \$\{prov\} for \$\{Math\.round\(\(streamState\.stallMs \|\| 120000\) \/ 1000\)\} s, not even a keep-alive/);
  assert.match(sdk, /if \(\/\^anthropic\\\/claude-\(\?:fable\|opus\|sonnet\|haiku\)-5\/i\.test\(model\) && !\['low', 'medium'\]\.includes\(turnEffort\) && !\(agentConfig && agentConfig\.maxOutputTokens\)\) maxTokens = Math\.max\(maxTokens, 64000\);/);
  assert.match(sdk, /if \(\/claude-\(\?:fable\|opus\|sonnet\|haiku\)-5\/i\.test\(m\)\) return 128000;/);
  const i = sdk.indexOf("if (lastFinishReason === 'length') {");
  const block = sdk.slice(i, i + 700);
  assert.match(block, /if \(!assistantText && allCalls\.length === 0\) \{\s*throw new Error\(`\$\{model\} used its whole output allowance/);
  assert.ok(block.indexOf('used its whole output allowance') < block.indexOf('lengthContinuations++') || block.indexOf('lengthContinuations++') < 0, 'checked before any continuation');
});

test('plain words for the two new failures', () => {
  const think = errorHelp.explain(new Error('anthropic/claude-fable-5-1 used its whole output allowance (64,000 tokens) thinking and wrote nothing.'), { model: 'anthropic/claude-fable-5-1' });
  assert.strictEqual(think.kind, 'thinking_budget');
  assert.match(think.what, /claude-fable-5-1 spent its whole output allowance thinking/);
  assert.match(think.fix, /lower its effort/);
  const stall = errorHelp.explain(new Error('No data from anthropic for 120 s, not even a keep-alive, so the hub closed the connection.'), { model: 'anthropic/claude-fable-5-1' });
  assert.strictEqual(stall.kind, 'stalled');
  assert.match(stall.what, /Anthropic sent nothing at all for 120 seconds/);
  const over = errorHelp.explain(Object.assign(new Error('Provider 529: {"error":{"type":"overloaded_error","message":"Overloaded","provider":"anthropic"}}'), { status: 529 }), { model: 'anthropic/claude-fable-5-1' });
  assert.strictEqual(over.kind, 'overloaded');
});

test('Claude on its API key gets its real context window, not the 128K default', () => {
  assert.strictEqual(cb.knownWindow('anthropic/claude-fable-5-1'), 1000000);
  assert.strictEqual(cb.knownWindow('anthropic/claude-opus-5-5'), 1000000);
  assert.strictEqual(cb.knownWindow('anthropic/claude-sonnet-5-5'), 1000000);
  assert.strictEqual(cb.knownWindow('anthropic/claude-haiku-4-5-20251001'), 200000);
  assert.strictEqual(cb.knownWindow('openai/unknown'), cb.DEFAULT_CLOUD, 'others unchanged');
});
