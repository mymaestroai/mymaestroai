#!/usr/bin/env node
// Probe every canonical chat model on the LLM Gateway:
//  1) basic chat completion works
//  2) tool-calling works (required for harness)
// Usage: node scripts/model-probe.js [batchStart batchEnd]
require('dotenv').config?.();
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const { chatCompletion } = require('../lib/gateway-client');

const MODELS = [
  // Claude
  'claude-3-5-haiku','claude-3-7-sonnet','claude-3-haiku','claude-fable-5',
  'claude-haiku-4-5','claude-opus-4','claude-opus-4-1','claude-opus-4-5',
  'claude-opus-4-6','claude-opus-4-7','claude-opus-4-8','claude-opus-5',
  'claude-sonnet-4','claude-sonnet-4-5','claude-sonnet-4-6','claude-sonnet-5',
  // Gemini
  'gemini-2.5-flash','gemini-2.5-flash-lite','gemini-2.5-pro',
  'gemini-3-flash-preview','gemini-3.1-flash-lite','gemini-3.1-pro-preview',
  'gemini-3.5-flash','gemini-3.5-flash-lite','gemini-3.6-flash',
  // GLM
  'glm-5.2','glm-5.2-fast',
  // GPT
  'gpt-4.1','gpt-4.1-mini','gpt-4.1-nano','gpt-4o','gpt-4o-mini',
  'gpt-5','gpt-5-chat','gpt-5-codex','gpt-5-mini','gpt-5-nano','gpt-5-pro',
  'gpt-5.1','gpt-5.1-codex','gpt-5.1-codex-max','gpt-5.1-codex-mini',
  'gpt-5.2','gpt-5.2-codex','gpt-5.3-codex',
  'gpt-5.4','gpt-5.4-mini','gpt-5.4-nano','gpt-5.4-pro',
  'gpt-5.5','gpt-5.6-luna','gpt-5.6-sol','gpt-5.6-terra',
  // Grok
  'grok-4-fast-reasoning','grok-4-1-fast-reasoning',
  // Kimi
  'kimi-k2.5','kimi-k3','kimi-k3-fast',
  // Others
  'nemotron-3-ultra','nova-lite-v1','nova-micro-v1','nova-premier-v1','nova-pro-v1',
  'o1','o3','o3-mini','o3-pro','o4-mini',
  'internal/flash-security-urt','internal/llama-security-urt',
  'auto','auto-balanced','auto-economy','auto-quality','openai-model-router',
  'self_hosted/qwen3-vl-4b',
];

const TOOL = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
}];

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT ' + ms + 'ms')), ms))]);
}

async function probe(model) {
  const r = { model, chat: null, tools: null, chatMs: 0, toolMs: 0, err: '' };
  // 1) basic chat
  let t = Date.now();
  try {
    const resp = await withTimeout(chatCompletion(
      [{ role: 'user', content: 'Reply with exactly: OK' }],
      { model, max_tokens: 2000 }
    ), 90000);
    const txt = resp?.choices?.[0]?.message?.content || '';
    r.chat = txt.length > 0 ? 'PASS' : 'EMPTY';
    r.chatMs = Date.now() - t;
  } catch (e) {
    r.chat = 'FAIL'; r.chatMs = Date.now() - t;
    r.err = (e.message || '').slice(0, 180);
    return r; // skip tool test if chat fails
  }
  // 2) tool calling
  t = Date.now();
  try {
    const resp = await withTimeout(chatCompletion(
      [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }],
      { model, max_tokens: 2000, tools: TOOL }
    ), 90000);
    const msg = resp?.choices?.[0]?.message || {};
    const tc = msg.tool_calls && msg.tool_calls.length > 0;
    r.tools = tc ? 'PASS' : 'NO_CALL';
    r.toolMs = Date.now() - t;
  } catch (e) {
    r.tools = 'FAIL'; r.toolMs = Date.now() - t;
    r.err = (e.message || '').slice(0, 180);
  }
  return r;
}

async function main() {
  const start = parseInt(process.argv[2] || '0');
  const end = parseInt(process.argv[3] || String(MODELS.length));
  const batch = MODELS.slice(start, end);
  const CONC = 6;
  const results = [];
  for (let i = 0; i < batch.length; i += CONC) {
    const chunk = batch.slice(i, i + CONC);
    const rs = await Promise.all(chunk.map(probe));
    for (const r of rs) {
      results.push(r);
      console.log(JSON.stringify(r));
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
