#!/usr/bin/env node
// Deep capability eval for harness-viable models.
// 8 verifiable tests: math, modular arithmetic, logic, tokenizer trap,
// code trace, strict formatting, JSON output, multi-turn tool use.
// Usage: node scripts/model-eval.js [batchStart batchEnd]
require('dotenv').config?.();
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const { chatCompletion } = require('../lib/gateway-client');

const MODELS = [
  'claude-fable-5','claude-opus-5','claude-opus-4-8','claude-opus-4-7',
  'claude-opus-4-6','claude-sonnet-5','claude-sonnet-4-6','claude-haiku-4-5',
  'gpt-5.6-luna','gpt-5.6-sol','gpt-5.6-terra','gpt-5.5','gpt-5.4','gpt-5.4-mini',
  'gpt-5.2','gpt-5.1','gpt-5',
  'gemini-3.1-pro-preview','gemini-3.5-flash','gemini-3.6-flash','gemini-2.5-pro',
  'grok-4-1-fast-reasoning','kimi-k2.5','o3','o4-mini',
  'nova-pro-v1','nova-premier-v1',
];

const TESTS = [
  { id: 'math', prompt: 'Compute 47 * 89 - 1234. Reply with ONLY the number, nothing else.', check: t => /\b2949\b/.test(t) },
  { id: 'modmath', prompt: 'What is the remainder when 7^100 is divided by 13? Reply with ONLY the number.', check: t => /\b9\b/.test(t.trim().split('\n').pop()) },
  { id: 'logic', prompt: "On an island, knights always tell the truth and knaves always lie. A says 'B is a knave'. B says 'A and I are of the same type'. What is A? Reply with ONLY the word knight or knave.", check: t => /knight/i.test(t) && !/A is a knave|^knave/im.test(t.trim()) },
  { id: 'tokentrap', prompt: "How many times does the letter r appear in the word strawberry? Reply with ONLY the number.", check: t => /\b3\b/.test(t) },
  { id: 'codetrace', prompt: "What does this Python print? print(sum(i*i for i in range(5))) Reply with ONLY the number.", check: t => /\b30\b/.test(t) },
  { id: 'format', prompt: 'List the first 5 prime numbers, comma-separated with no spaces, and output NOTHING else.', check: t => t.replace(/\s/g,'').includes('2,3,5,7,11') },
  { id: 'json', prompt: 'Return a JSON object with key "a" set to the integer 1 and key "b" set to the string "x". Output ONLY the JSON.', check: t => { try { const m = t.match(/\{[\s\S]*\}/); const o = JSON.parse(m[0]); return o.a === 1 && o.b === 'x'; } catch { return false; } } },
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
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), ms))]);
}

async function runTest(model, test) {
  const t = Date.now();
  try {
    const resp = await withTimeout(chatCompletion(
      [{ role: 'user', content: test.prompt }],
      { model, max_tokens: 4000 }
    ), 120000);
    const txt = resp?.choices?.[0]?.message?.content || '';
    return { pass: test.check(txt), ms: Date.now() - t, out: txt.slice(0, 80) };
  } catch (e) {
    return { pass: false, ms: Date.now() - t, out: 'ERR: ' + (e.message || '').slice(0, 80) };
  }
}

// Multi-turn tool test: model calls tool, gets result, must use it in final answer
async function runToolChain(model) {
  const t = Date.now();
  try {
    const msgs = [{ role: 'user', content: 'What is the current temperature in Paris? Use the get_weather tool.' }];
    const r1 = await withTimeout(chatCompletion(msgs, { model, max_tokens: 4000, tools: TOOL }), 120000);
    const m1 = r1?.choices?.[0]?.message;
    if (!m1?.tool_calls?.length) return { pass: false, ms: Date.now() - t, out: 'no tool call' };
    msgs.push(m1);
    msgs.push({ role: 'tool', tool_call_id: m1.tool_calls[0].id, content: JSON.stringify({ temp_c: 22, condition: 'sunny' }) });
    const r2 = await withTimeout(chatCompletion(msgs, { model, max_tokens: 4000, tools: TOOL }), 120000);
    const txt = r2?.choices?.[0]?.message?.content || '';
    return { pass: /22/.test(txt), ms: Date.now() - t, out: txt.slice(0, 80) };
  } catch (e) {
    return { pass: false, ms: Date.now() - t, out: 'ERR: ' + (e.message || '').slice(0, 80) };
  }
}

async function evalModel(model) {
  const res = { model, scores: {}, pass: 0, total: TESTS.length + 1, avgMs: 0 };
  let totMs = 0;
  for (const test of TESTS) {
    const r = await runTest(model, test);
    res.scores[test.id] = r.pass ? 'P' : 'F(' + r.out.replace(/\n/g, ' ') + ')';
    if (r.pass) res.pass++;
    totMs += r.ms;
  }
  const tc = await runToolChain(model);
  res.scores.toolchain = tc.pass ? 'P' : 'F(' + tc.out.replace(/\n/g, ' ') + ')';
  if (tc.pass) res.pass++;
  totMs += tc.ms;
  res.avgMs = Math.round(totMs / (TESTS.length + 1));
  return res;
}

async function main() {
  const start = parseInt(process.argv[2] || '0');
  const end = parseInt(process.argv[3] || String(MODELS.length));
  const batch = MODELS.slice(start, end);
  const CONC = 4;
  for (let i = 0; i < batch.length; i += CONC) {
    const chunk = batch.slice(i, i + CONC);
    const rs = await Promise.all(chunk.map(evalModel));
    for (const r of rs) console.log(JSON.stringify(r));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
