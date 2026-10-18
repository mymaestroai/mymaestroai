require('dotenv').config();
const gw = require('../lib/gateway-client');

const MODELS = process.env.LP_MODELS
  ? process.env.LP_MODELS.split(',')
  : ['claude-opus-5','claude-sonnet-5','claude-haiku-4-5','gpt-5.5','gpt-5.6-terra','gemini-3.5-flash'];
const PROMPT = 'Reply with exactly the word: ok';

async function one(model, maxTokens, sysPad, tools) {
  const messages = [{ role: 'user', content: PROMPT }];
  const t0 = Date.now();
  let ttft = null, out = '';
  try {
    const resp = await gw.chatCompletionStream(messages, {
      model, max_tokens: maxTokens, system: sysPad || undefined, tools: tools || undefined,
    });
    for await (const chunk of gw.parseSSEStream(resp)) {
      const d = chunk?.choices?.[0]?.delta?.content;
      if (d) { if (ttft === null) ttft = Date.now() - t0; out += d; }
    }
  } catch (e) { return { model, err: e.message.slice(0, 120) }; }
  return { model, ttft, total: Date.now() - t0, len: out.length };
}

(async () => {
  const mode = process.argv[2] || 'basic';
  const maxTokens = Number(process.argv[3] || 1024);
  const runs = Number(process.argv[4] || 3);
  let pad = null;
  if (mode === 'pad') pad = 'You are a helpful assistant.  ' + 'Reference context sentence used purely as token padding for latency measurement.  '.repeat(1200);
  let tools = null;
  if (mode === 'tools') {
    tools = [];
    for (let i = 0; i < 140; i++) tools.push({
      type: 'function',
      function: {
        name: `probe_tool_${i}`,
        description: `Probe tool number ${i}.  ${'Detailed description text used to approximate a real MCP tool schema payload.  '.repeat(6)}`,
        parameters: { type: 'object', properties: { a: { type: 'string', description: 'first arg' }, b: { type: 'number', description: 'second arg' } }, required: ['a'] },
      },
    });
  }
  console.log(`mode=${mode} max_tokens=${maxTokens} runs=${runs} padChars=${pad ? pad.length : 0} tools=${tools ? tools.length : 0}`);
  for (const m of MODELS) {
    const r = [];
    for (let i = 0; i < runs; i++) r.push(await one(m, maxTokens, pad, tools));
    const ok = r.filter(x => x.ttft != null);
    if (!ok.length) { console.log(m.padEnd(24), 'FAIL', r[0].err); continue; }
    const avg = a => Math.round(a.reduce((s, x) => s + x, 0) / a.length);
    console.log(m.padEnd(24), 'ttft', String(avg(ok.map(x => x.ttft))).padStart(6), 'ms   total', String(avg(ok.map(x => x.total))).padStart(6), 'ms   runs', ok.map(x => x.ttft).join('/'));
  }
})();
