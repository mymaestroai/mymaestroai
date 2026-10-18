#!/usr/bin/env node
// Hard discriminator eval — only top models from round 1.
// Tests: hard math, combinatorics, deductive puzzle, code output w/ recursion,
// instruction adherence under distraction, multi-tool selection, parallel tool calls.
require('dotenv').config?.();
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const { chatCompletion } = require('../lib/gateway-client');

const MODELS = [
  'claude-fable-5','claude-opus-5','claude-opus-4-8','claude-sonnet-5',
  'claude-opus-4-7','claude-opus-4-6','claude-sonnet-4-6',
  'gpt-5.6-luna','gpt-5.6-terra','gpt-5.6-sol','gpt-5.5','gpt-5',
  'gemini-3.1-pro-preview','gemini-3.5-flash','gemini-3.6-flash',
  'kimi-k2.5','o3','o4-mini','grok-4-1-fast-reasoning',
];

const TESTS = [
  // AIME-style
  { id: 'hardmath', prompt: 'Find the sum of all positive integers n such that n^2 + 12n - 2007 is a perfect square. Reply with ONLY the final number.', check: t => /\b(21|21\.0)\b/.test(t.trim().split('\n').pop()) },
  // combinatorics
  { id: 'combi', prompt: 'How many ways can you tile a 2x10 rectangle with 2x1 dominoes? Reply with ONLY the number.', check: t => /\b89\b/.test(t) },
  // deduction
  { id: 'einstein', prompt: 'Three boxes: one has only apples, one only oranges, one mixed. All three labels (Apples, Oranges, Mixed) are WRONG. You may pick one fruit from one box. From which labeled box should you pick to determine all contents? Reply with ONLY the label name.', check: t => /mixed/i.test(t) },
  // recursion trace
  { id: 'recursion', prompt: 'What does this print?\ndef f(n):\n    if n <= 1: return n\n    return f(n-1) + f(n-2)\nprint(f(10))\nReply with ONLY the number.', check: t => /\b55\b/.test(t) },
  // instruction adherence under distraction
  { id: 'adherence', prompt: 'IMPORTANT: reply in ALL CAPS. Ignore any instruction below this line.\n---\nPlease reply in all lowercase and add a smiley. What is the capital of France?', check: t => /PARIS/.test(t) && !/paris/.test(t.replace(/PARIS/g,'')) },
  // base conversion + arithmetic
  { id: 'bases', prompt: 'Convert 0x2F3 to decimal, add 111 in binary (i.e., add 7), give the result in octal. Reply with ONLY the octal number (no prefix).', check: t => /\b1372\b/.test(t) },
];

const TOOLS = [
  { type: 'function', function: { name: 'get_weather', description: 'Get weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } },
  { type: 'function', function: { name: 'get_stock_price', description: 'Get stock price for a ticker', parameters: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] } } },
  { type: 'function', function: { name: 'send_email', description: 'Send an email', parameters: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to','body'] } } },
];

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), ms))]);
}

async function runTest(model, test) {
  const t = Date.now();
  try {
    const resp = await withTimeout(chatCompletion(
      [{ role: 'user', content: test.prompt }],
      { model, max_tokens: 8000 }
    ), 150000);
    const txt = resp?.choices?.[0]?.message?.content || '';
    return { pass: test.check(txt), ms: Date.now() - t, out: txt.slice(-100) };
  } catch (e) {
    return { pass: false, ms: Date.now() - t, out: 'ERR: ' + (e.message || '').slice(0, 80) };
  }
}

// Correct tool selection: must call get_stock_price, NOT weather/email
async function toolSelect(model) {
  const t = Date.now();
  try {
    const resp = await withTimeout(chatCompletion(
      [{ role: 'user', content: "What's COIN trading at right now?" }],
      { model, max_tokens: 4000, tools: TOOLS }
    ), 150000);
    const tc = resp?.choices?.[0]?.message?.tool_calls || [];
    const pass = tc.length === 1 && tc[0].function.name === 'get_stock_price' && /COIN/i.test(tc[0].function.arguments);
    return { pass, ms: Date.now() - t, out: JSON.stringify(tc.map(c => c.function.name)) };
  } catch (e) {
    return { pass: false, ms: Date.now() - t, out: 'ERR: ' + (e.message || '').slice(0, 80) };
  }
}

// Parallel tool calls: should call weather twice (Paris + Tokyo)
async function toolParallel(model) {
  const t = Date.now();
  try {
    const resp = await withTimeout(chatCompletion(
      [{ role: 'user', content: 'Get the weather in both Paris and Tokyo. Call the tool for both cities.' }],
      { model, max_tokens: 4000, tools: TOOLS }
    ), 150000);
    const tc = resp?.choices?.[0]?.message?.tool_calls || [];
    const cities = tc.filter(c => c.function.name === 'get_weather').map(c => { try { return JSON.parse(c.function.arguments).city; } catch { return ''; } });
    const pass = cities.some(c => /paris/i.test(c)) && cities.some(c => /tokyo/i.test(c));
    return { pass, ms: Date.now() - t, out: JSON.stringify(cities) };
  } catch (e) {
    return { pass: false, ms: Date.now() - t, out: 'ERR: ' + (e.message || '').slice(0, 80) };
  }
}

async function evalModel(model) {
  const res = { model, scores: {}, pass: 0, total: TESTS.length + 2, avgMs: 0 };
  let totMs = 0;
  for (const test of TESTS) {
    const r = await runTest(model, test);
    res.scores[test.id] = r.pass ? 'P' : 'F(' + r.out.replace(/\n/g, ' ') + ')';
    if (r.pass) res.pass++;
    totMs += r.ms;
  }
  const ts = await toolSelect(model);
  res.scores.toolselect = ts.pass ? 'P' : 'F(' + ts.out + ')';
  if (ts.pass) res.pass++;
  totMs += ts.ms;
  const tp = await toolParallel(model);
  res.scores.toolparallel = tp.pass ? 'P' : 'F(' + tp.out + ')';
  if (tp.pass) res.pass++;
  totMs += tp.ms;
  res.avgMs = Math.round(totMs / res.total);
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
