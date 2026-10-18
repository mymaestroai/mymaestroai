require('dotenv').config({ quiet: true });
const tls = require('tls');
const gw = require('../lib/gateway-client');

const MODELS = (process.env.PP_MODELS || 'claude-opus-5,claude-haiku-4-5,gpt-5.5').split(',');
const RUNS = Number(process.argv[2] || 3);

function tcpTls(host) {
  return new Promise((res) => {
    const t0 = Date.now();
    const s = tls.connect({ host, port: 443, servername: host }, () => {
      const ms = Date.now() - t0; s.end(); res(ms);
    });
    s.on('error', () => res(-1));
  });
}

async function phases(model) {
  const messages = [{ role: 'user', content: 'Reply with exactly the word: ok' }];
  const t0 = Date.now();
  let tHeaders = null, tFirstFrame = null, tFirstContent = null, frames = 0, out = '';
  try {
    const resp = await gw.chatCompletionStream(messages, { model, max_tokens: 64 });
    tHeaders = Date.now() - t0;
    for await (const chunk of gw.parseSSEStream(resp)) {
      frames++;
      if (tFirstFrame === null) tFirstFrame = Date.now() - t0;
      const d = chunk?.choices?.[0]?.delta?.content;
      if (d) { if (tFirstContent === null) tFirstContent = Date.now() - t0; out += d; }
    }
  } catch (e) { return { model, err: e.message.slice(0, 100) }; }
  return { model, tHeaders, tFirstFrame, tFirstContent, total: Date.now() - t0, frames, len: out.length };
}

(async () => {
  const host = (process.env.LLM_GATEWAY_URL || 'https://llm-gateway.internal.example').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const handshakes = [];
  for (let i = 0; i < 3; i++) handshakes.push(await tcpTls(host));
  console.log(`host=${host}  TCP+TLS handshake: ${handshakes.join('/')} ms`);
  console.log('');
  for (const m of MODELS) {
    const rs = [];
    for (let i = 0; i < RUNS; i++) rs.push(await phases(m));
    const ok = rs.filter((r) => !r.err);
    if (!ok.length) { console.log(m.padEnd(22), 'FAIL', rs[0].err); continue; }
    const avg = (f) => Math.round(ok.reduce((s, r) => s + (r[f] || 0), 0) / ok.length);
    console.log(
      m.padEnd(22),
      'headers', String(avg('tHeaders')).padStart(6),
      '| 1stFrame', String(avg('tFirstFrame')).padStart(6),
      '| 1stContent', String(avg('tFirstContent')).padStart(6),
      '| total', String(avg('total')).padStart(6),
      '| frames', avg('frames'),
    );
  }
})();
