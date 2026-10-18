'use strict';
// Provider errors in plain words (lib/error-help): what happened and what to do instead of the raw "Provider 404: {json}".
// Plain rules over the status and the provider's message: no model is asked, so it works when every provider is down.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// A fixed OpenRouter catalogue, so the free -> paid suggestion does not depend on this machine's cached list.
const CAT = {
  'nvidia/nemotron-3.5-super-vl:free': { id: 'nvidia/nemotron-3.5-super-vl:free', name: 'NVIDIA: Nemotron 3.5 Super VL (free)', context: 1000000, prompt: 0, completion: 0 },
  'nvidia/nemotron-3.5-super-vl': { id: 'nvidia/nemotron-3.5-super-vl', name: 'NVIDIA: Nemotron 3.5 Super VL', context: 1048576, prompt: 1e-7, completion: 4e-7 },
  'acme/solo:free': { id: 'acme/solo:free', name: 'Acme: Solo (free)', context: 32768, prompt: 0, completion: 0 },
  'x-ai/grok-4.7': { id: 'x-ai/grok-4.7', name: 'xAI: Grok 4.7', context: 500000, prompt: 2e-6, completion: 1e-5 },
  'evil/model': { id: 'evil/model', name: 'Evil: **Bold** `tick` <b>x</b>', context: 8192, prompt: 1e-6, completion: 1e-6 },
};
require.cache[require.resolve('../lib/openrouter')] = { id: 'or-stub', filename: 'or-stub', loaded: true, exports: { getOpenRouter: () => ({ info: (id) => CAT[String(id).replace(/^openrouter\//, '')] || null }) } };
const help = require('../lib/error-help');

const E = (m, extra) => Object.assign(new Error(m), extra || {});
const REPORTED = 'Provider 404: {"error":{"message":"No endpoints found matching your data policy (Free model training). Configure: https://openrouter.ai/settings/privacy","code":404,"metadata":{"routing_funnel":[{"step":"Initial Endpoints","endpoint_count":1}],"failed_routing_step":"Filter by Data Policy"}}}';

test('the reported error: a free OpenRouter model refused by the privacy setting, with the paid version suggested', () => {
  const x = help.explain(E(REPORTED), { model: 'openrouter/nvidia/nemotron-3.5-super-vl:free' });
  assert.strictEqual(x.kind, 'privacy');
  assert.strictEqual(x.title, "Nemotron 3.5 Super VL (free) couldn't reply.");
  assert.match(x.what, /free version only runs on servers that may train on your prompts, and the hub's privacy setting blocks those/);
  assert.match(x.fix, /Switch to the paid version, `nvidia\/nemotron-3\.5-super-vl`, in the model picker \(🔎 More OpenRouter models…\); it costs \$0\.10 \/ \$0\.40 per million tokens\./);
  assert.match(x.fix, /Turning privacy off in Settings → OpenRouter would also work, but the free server could then train on what this agent sends\./);
  assert.strictEqual(x.detail, 'OpenRouter 404: No endpoints found matching your data policy (Free model training). Configure: https://openrouter.ai/settings/privacy');
  const t = help.text(E(REPORTED), { model: 'openrouter/nvidia/nemotron-3.5-super-vl:free' });
  assert.match(t, /^⚠️ \*\*Nemotron 3\.5 Super VL \(free\) couldn't reply\.\*\* This free version/);
  assert.match(t, /\n\n\*\*What to do:\*\* Switch to the paid version/);
  assert.match(t, /\n\nDetails: OpenRouter 404: No endpoints found matching your data policy/);
  assert.doesNotMatch(t, /routing_funnel|\{"error"/, 'no raw JSON');
});

test('privacy refusal without a paid version: pick another model or turn privacy off', () => {
  const x = help.explain(E(REPORTED.replace('Free model training', 'Paid model training')), { model: 'openrouter/acme/solo:free' });
  assert.strictEqual(x.kind, 'privacy');
  assert.match(x.fix, /^Pick another model\. Or turn privacy off in Settings → OpenRouter/);
});

test('credit, key limit and key refusals name the place to fix them', () => {
  const credit = help.explain(E('Provider 402: {"error":{"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits","code":402}}'), { model: 'openrouter/x-ai/grok-4.7' });
  assert.strictEqual(credit.kind, 'credit');
  assert.strictEqual(credit.what, 'The OpenRouter account is out of credit.');
  assert.match(credit.fix, /^Add credit at openrouter\.ai\/settings\/credits, then send again\./);
  const keyLimit = help.explain(E('Provider 403: {"error":{"message":"Key limit exceeded (total limit). Manage it using https://openrouter.ai/settings/keys","code":403}}'), { model: 'openrouter/x-ai/grok-4.7' });
  assert.strictEqual(keyLimit.kind, 'key_limit');
  assert.match(keyLimit.fix, /openrouter\.ai\/settings\/keys/);
  const quota = help.explain(E('Provider 429: {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}'), { model: 'openai/gpt-5.5' });
  assert.strictEqual(quota.kind, 'credit', 'OpenAI reports an empty account as 429 insufficient_quota: credit, not a rate limit');
  assert.match(quota.fix, /platform\.openai\.com\/settings\/organization\/billing/);
  const auth = help.explain(E('Provider 401: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), { model: 'anthropic/claude-sonnet-5-5' });
  assert.strictEqual(auth.kind, 'auth');
  assert.strictEqual(auth.what, 'Anthropic refused the API key.');
  assert.strictEqual(auth.fix, 'Paste a new key in Settings → LLM Providers → Anthropic, press Test, then Save.');
  assert.strictEqual(auth.detail, 'Anthropic 401: invalid x-api-key');
});

test('too long for the model: the limit from the catalogue or from the provider\'s message, and how to start over', () => {
  const oa = help.explain(E('Provider 400: {"error":{"message":"This model\'s maximum context length is 128000 tokens. However, your messages resulted in 140000 tokens.","code":"context_length_exceeded"}}'), { model: 'openai/gpt-5.5' });
  assert.strictEqual(oa.kind, 'context');
  assert.strictEqual(oa.what, 'This conversation is too long for gpt-5.5 (it reads up to 128K tokens).');
  assert.match(oa.fix, /New Session above the chat on the desktop; ⋮ → Clear chat \/ new session on the phone/);
  const or = help.explain(E('Provider 400: {"error":{"message":"Provider returned error","code":400,"metadata":{"raw":"{\\"error\\":{\\"message\\":\\"prompt is too long: 600000 tokens\\"}}"}}}'), { model: 'openrouter/x-ai/grok-4.7' });
  assert.strictEqual(or.kind, 'context', 'OpenRouter\'s wrapped upstream message is read');
  assert.match(or.what, /\(it reads up to 500K tokens\)/);
  assert.match(or.detail, /Provider returned error: prompt is too long/);
});

test('rate limits: free versions point at the paid one; others say how long to wait', () => {
  const free = help.explain(E('Provider 429: {"error":{"message":"Rate limit exceeded: free-models-per-min.","code":429}}'), { model: 'openrouter/nvidia/nemotron-3.5-super-vl:free' });
  assert.strictEqual(free.kind, 'rate_limit');
  assert.match(free.what, /^Free versions only allow a few requests a minute/);
  assert.match(free.fix, /switch to the paid version, `nvidia\/nemotron-3\.5-super-vl`/);
  const paid = help.explain(E('Provider 429: Too many requests, retry-after: 20'), { model: 'google/gemini-4-argon' });
  assert.strictEqual(paid.kind, 'rate_limit');
  assert.strictEqual(paid.what, 'Google is limiting how fast this key can send requests.');
  assert.match(paid.fix, /^Wait about 20 seconds and send again/);
});

test('models that cannot use tools, and models that are gone', () => {
  const tools = help.explain(E('Provider 404: {"error":{"message":"No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing","code":404}}'), { model: 'openrouter/gryphe/mythomax-l2-13b' });
  assert.strictEqual(tools.kind, 'no_tools');
  assert.match(tools.fix, /marked 🛠/);
  const gone = help.explain(E('Provider 404: {"error":{"message":"The model `gpt-4-old` does not exist or you do not have access to it.","code":"model_not_found"}}'), { model: 'openai/gpt-4-old' });
  assert.strictEqual(gone.kind, 'not_found');
  assert.strictEqual(gone.what, "OpenAI doesn't offer `gpt-4-old` right now: it may have been retired or renamed.");
});

test('connection problems: a local server that is not running, the internet, a busy provider, a fallback', () => {
  const refused = E('fetch failed', { cause: E('connect ECONNREFUSED 127.0.0.1:18080', { code: 'ECONNREFUSED' }) });
  const local = help.explain(refused, { model: 'local/qwen3.8-27b' });
  assert.strictEqual(local.kind, 'local_down');
  assert.strictEqual(local.what, "The local model server isn't running, so the model can't answer.");
  assert.match(local.fix, /Local models page/);
  assert.match(local.detail, /^Local models: fetch failed · connect ECONNREFUSED 127\.0\.0\.1:18080/, 'the cause is in the details, not just "fetch failed"');
  const ollama = help.explain(refused, { model: 'ollama/llama3' });
  assert.strictEqual(ollama.fix, 'Start Ollama, then send again.');
  const net = help.explain(E('fetch failed', { cause: E('getaddrinfo ENOTFOUND openrouter.ai', { code: 'ENOTFOUND' }) }), { model: 'openrouter/x-ai/grok-4.7' });
  assert.strictEqual(net.kind, 'network');
  assert.strictEqual(net.what, "The hub couldn't reach OpenRouter.");
  assert.match(net.fix, /Anything already written above is kept\./);
  const busy = help.explain(E('Provider 529: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', { status: 529 }), { model: 'anthropic/claude-opus-5-5' });
  assert.strictEqual(busy.kind, 'overloaded');
  const odd = help.explain(E('Provider 418: I am a teapot'), { model: 'perplexity/sonar' });
  assert.strictEqual(odd.kind, 'error');
  assert.strictEqual(odd.what, 'Perplexity returned an error (HTTP 418).');
  assert.strictEqual(odd.fix, 'Send again. If it keeps happening, pick another model.');
});

test('a bare message string works too (the OpenAI Responses failure), and an unknown model still reads well', () => {
  const v = help.explain('Your organization must be verified to use the model `o5`.', { provider: 'openai' });
  assert.strictEqual(v.kind, 'verification');
  assert.strictEqual(v.title, "The model couldn't reply.");
  assert.match(v.fix, /platform\.openai\.com\/settings\/organization\/general/);
});

test('nothing from the provider can turn into markdown or markup', () => {
  const t = help.text(E('Provider 500: {"error":{"message":"**boom** _x_ `y` <script>alert(1)</script> [link](http://e.x) | # h"}}'), { model: 'openrouter/evil/model' });
  const details = t.split('\n\nDetails: ')[1];
  assert.doesNotMatch(details, /[*_`<>[\]|#]/);
  assert.match(t, /^⚠️ \*\*Bold tick b x \/b couldn't reply\.\*\*/, 'catalogue names are cleaned too');
});

test('wired into the replies: the API route and the OpenAI Responses failure; raw provider text stays in the log', () => {
  const root = path.join(__dirname, '..');
  const chat = fs.readFileSync(path.join(root, 'lib/sdk-chat.js'), 'utf8');
  const gw = fs.readFileSync(path.join(root, 'lib/gateway-client.js'), 'utf8');
  assert.match(chat, /turnErrorInfo = errorHelp\.explain\(e, \{ model \}\);/);
  assert.match(chat, /const explained = errorHelp\.format\(turnErrorInfo\);\n\s*sendSSE\(res, makeChunk\(`\\n\\n\$\{explained\}`, model\)\);/);
  assert.match(chat, /fullResponse \+= \(fullResponse \? '\\n\\n' : ''\) \+ explained;/, 'saved with the reply: a reload or another device shows why there was no answer');
  assert.match(chat, /if \(!terminalError\) writeAutoMemory\(agentName, userMessage, fullResponse\)/, 'a failed reply is not written to the agent\'s session notes');
  assert.doesNotMatch(chat, /\[Error: \$\{e\.message\}\]|Network error occurred/, 'the raw texts are gone from replies');
  assert.match(chat, /console\.error\(`\[chat\] \$\{agentName\}: stream error:`, e\.message\);/);
  assert.match(gw, /err\.status = response\.status;/);
  assert.match(gw, /content: `\\n\\n\$\{require\('\.\/error-help'\)\.text\(errMsg, \{ provider: 'openai' \}\)\}`/);
  assert.doesNotMatch(gw, /\[Error: \$\{errMsg\}\]/);
});
