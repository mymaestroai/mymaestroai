'use strict';
// Prompt caching on the gateway path: what the hub sends must keep the same opening from call to call (stable
// time labels, block trimming, per-message hits outside the system prompt), Anthropic gets cache breakpoints,
// OpenAI a per-agent cache key, and the ledger prices cached tokens at the cache rates.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const log = console.log; console.log = () => {};
const gw = require('../lib/gateway-client');
const { __cache } = require('../lib/sdk-chat');
const { estimateCost } = require('../lib/ledger');
console.log = log;

const hist = (n, t0 = Date.parse('2026-10-14T10:00:00')) => Array.from({ length: n }, (_, i) =>
  ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}`, ts: new Date(t0 + i * 60000).toISOString() }));

test('past messages carry absolute times, so the same history renders identically on later turns', () => {
  const h = hist(5);
  const a = __cache.annotateForContext(h, { now: Date.parse('2026-10-14T11:00:00') });
  const b = __cache.annotateForContext(h, { now: Date.parse('2026-10-14T15:30:00') });
  assert.deepStrictEqual(a.slice(0, -1), b.slice(0, -1), 'history prefix unchanged hours later');
  assert.match(a[0].content, /^\[Oct 14 10:00\] m0$/);
  assert.doesNotMatch(JSON.stringify(a), /m ago\]|h ago\]|d ago\]/);
  assert.match(a.at(-1).content, /^<current_request sent="Oct 14 2026 11:00">\nm4\n<\/current_request>$/);
});

test('hub context (search hits) rides with the current request, never in the history', () => {
  const out = __cache.annotateForContext(hist(3), { hubContext: '## Possibly relevant earlier exchanges\nhit', now: Date.parse('2026-10-14T11:00:00') });
  assert.match(out.at(-1).content, /^<hub_context>\n## Possibly relevant earlier exchanges\nhit\n<\/hub_context>\n<current_request /);
  assert.ok(!out.slice(0, -1).some(m => /hub_context/.test(m.content)));
  const multi = __cache.annotateForContext([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }], { hubContext: 'hits' });
  assert.strictEqual(multi[0].content[0].type, 'text');
  assert.match(multi[0].content[0].text, /<hub_context>\nhits\n<\/hub_context>/);
});

test('stableTrim keeps the same first message for several turns while history grows', () => {
  const firsts = new Set();
  for (let total = 50; total < 50 + __cache.CACHE_TRIM_STEP; total += 2) {
    const h = hist(total);
    const window = h.slice(-40);                       // what the count cap would keep: slides every turn
    const kept = __cache.stableTrim(window, total);
    assert.strictEqual(kept.at(-1), h.at(-1), 'the current message is always kept');
    assert.strictEqual(kept[0].role, 'user');
    assert.ok(kept.length <= window.length);
    firsts.add(kept[0].content);
  }
  assert.ok(firsts.size <= 2, `first message changed ${firsts.size} times over ${__cache.CACHE_TRIM_STEP / 2} turns`);
  assert.deepStrictEqual(__cache.stableTrim(hist(10), 10).length, 10, 'nothing trimmed -> untouched');
});

test('Anthropic: breakpoints on the last tool, the system prompt and the last message block; off by setting', () => {
  const body = {
    system: 'sys', tools: [{ name: 'a', input_schema: {} }, { name: 'b', input_schema: {} }],
    messages: gw.convertToAnthropicMessages([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'again' }]),
  };
  gw.applyAnthropicCache(body);
  assert.strictEqual(body.tools[0].cache_control, undefined);
  assert.deepStrictEqual(body.tools[1].cache_control, { type: 'ephemeral' });
  assert.deepStrictEqual(body.system, [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
  assert.deepStrictEqual(body.messages.at(-1).content.at(-1).cache_control, { type: 'ephemeral' });
  assert.strictEqual(body.messages[0].content[0].cache_control, undefined, 'only the last message is marked');
  const marks = JSON.stringify(body).split('cache_control').length - 1;
  assert.ok(marks <= 4, 'API allows at most 4 breakpoints');
});

test('OpenAI cache key is per agent and does not contain the agent name', () => {
  const k = gw.openAiCacheKey('doc');
  assert.match(k, /^hub-[0-9a-f]{24}$/);
  assert.strictEqual(k, gw.openAiCacheKey('doc'));
  assert.notStrictEqual(k, gw.openAiCacheKey('counsel'));
  assert.strictEqual(gw.openAiCacheKey(null), null);
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'gateway-client.js'), 'utf8');
  assert.strictEqual((src.match(/if \(provider === 'openai'\) \{ const k = openAiCacheKey\(options\.agent\); if \(k\) body\.prompt_cache_key = k; \}/g) || []).length, 2);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'lib', 'openai-responses.js'), 'utf8'), /if \(body\.prompt_cache_key\) out\.prompt_cache_key = body\.prompt_cache_key;/);
});

test('ledger: the cached part of the input is priced at cache rates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-cache-'));
  const { createLedger } = require('../lib/ledger');
  const l = createLedger({ file: path.join(dir, 'l.db') });
  const plain = l.record({ agent: 'a', model: 'anthropic/claude-sonnet-5-5', inputTokens: 100000, outputTokens: 100 });
  const cached = l.record({ agent: 'a', model: 'anthropic/claude-sonnet-5-5', inputTokens: 100000, outputTokens: 100, cacheRead: 90000, cacheWrite: 0 });
  assert.ok(Math.abs(cached.cost - estimateCost('anthropic/claude-sonnet-5-5', 10000, 100, { cacheRead: 90000 })) < 1e-12);
  assert.ok(cached.cost < plain.cost / 3, `cached ${cached.cost} vs plain ${plain.cost}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('gateway system prompt no longer contains the per-message hits; the loop passes the agent name', () => {
  const chat = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(chat, /hitsOut: hubContextOut \}\);/);
  assert.match(chat, /annotateForContext\(trimmed, \{ hubContext: hubContextOut\.text \|\| '', timeZone: timeZoneLib\.zoneForAgent\(agentName\) \}\)/);
  assert.match(chat, /noRetries: !!recoveryCall, agent: agentName, effort: turnEffort \}/);
  const agents = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agents.js'), 'utf8');
  assert.match(agents, /if \(opts\.hitsOut && typeof opts\.hitsOut === 'object'\) opts\.hitsOut\.text = hitsText; else sections\.push\(hitsText\);/);
});
