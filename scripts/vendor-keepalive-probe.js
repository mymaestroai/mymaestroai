#!/usr/bin/env node
/**
 * vendor-keepalive-probe.js — Cross-vendor efficacy test for the gateway
 * keep-alive pool.  Answers: "does keep-alive help non-Anthropic models too?"
 *
 * DESIGN (per gptchallenger's falsifiability requirements):
 *   - COLD and WARM samples are INTERLEAVED and the provider order is
 *     RANDOMIZED on every trial.  This is the key difference from
 *     keepalive-ab.js, which ran all-OFF then all-ON and is therefore
 *     confounded by gateway load / time-of-day drift.
 *   - COLD = a throwaway undici Agent created for that single request and
 *     destroyed immediately after.  Guarantees a fresh TCP+TLS handshake.
 *   - WARM = one long-lived singleton Agent, pre-established, and the sample
 *     is only counted if the socket actually reported reused=true.
 *   - Concurrency is exactly 1 in-flight request.  This isolates the
 *     transport effect from pool queueing and stream-occupancy effects.
 *   - Identical prompt / max_tokens / streaming mode for every model.
 *   - Reports ABSOLUTE ms saved (the transport claim) separately from
 *     PERCENT saved (which necessarily varies with provider base latency).
 *
 * Usage:
 *   node scripts/vendor-keepalive-probe.js                 # 8 trials/model
 *   node scripts/vendor-keepalive-probe.js 12
 *   node scripts/vendor-keepalive-probe.js 8 claude-opus-5,gpt-5.5
 */

require('dotenv').config();
const { Agent } = require('undici');
const dc = require('diagnostics_channel');
const { applyQuirks } = require('../lib/model-quirks');

const TRIALS = Number(process.argv[2] || 8);
const MODELS = (process.argv[3] || [
  'claude-opus-5',        // Anthropic
  'gpt-5.5',              // OpenAI
  'gemini-3.5-flash',     // Google
  'grok-4-1-fast-reasoning', // xAI
  'kimi-k2.5',            // Moonshot
].join(',')).split(',');

const VENDOR = m =>
  /claude/i.test(m) ? 'Anthropic' :
  /gpt|^o\d/i.test(m) ? 'OpenAI' :
  /gemini/i.test(m) ? 'Google' :
  /grok/i.test(m) ? 'xAI' :
  /kimi/i.test(m) ? 'Moonshot' : 'other';

// Use the REAL client's URL + auth headers.  Do not duplicate the auth
// logic here — it drifts, and a wrong header silently turns every sample
// into a 401 that looks like a latency result.
const gw = require('../lib/gateway-client');
const GATEWAY_URL = gw.GATEWAY_URL;
const getHeaders = gw.getHeaders;

// ── socket observation ──────────────────────────────────────────────────
// We tag each request with a correlation id and read the socket facts off
// the wire via diagnostics_channel, same mechanism as lib/http-agent.js.

let nextSock = 1;
const sockIds = new WeakMap();
const pending = new Map();   // reqId -> {}

function hdrVal(headers, name) {
  if (!headers) return null;
  const want = name.toLowerCase();
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length - 1; i += 2) {
      const k = String(headers[i]).toLowerCase();
      if (k === want) return String(headers[i + 1]);
    }
    return null;
  }
  if (typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (String(k).toLowerCase() === want) return Array.isArray(v) ? v[0] : String(v);
    }
  }
  return null;
}

dc.subscribe('undici:client:sendHeaders', ({ request, socket }) => {
  try {
    const reqId = hdrVal(request?.headers, 'x-hub-req-id');
    if (!reqId || !pending.has(reqId)) return;
    if (!sockIds.has(socket)) sockIds.set(socket, nextSock++);
    const rec = pending.get(reqId);
    rec.socketId = sockIds.get(socket);
    rec.reused = !!(socket.__hubUsed);
    rec.alpn = socket.alpnProtocol || null;
    rec.tls = typeof socket.getProtocol === 'function' ? socket.getProtocol() : null;
    socket.__hubUsed = true;
  } catch (_) {}
});

// ── one measured request ────────────────────────────────────────────────

async function once(model, dispatcher) {
  const reqId = `p${Math.random().toString(36).slice(2, 10)}`;
  pending.set(reqId, {});

  // applyQuirks returns { body, changes } and mutates in place — take .body
  const { body } = applyQuirks({
    model,
    messages: [{ role: 'user', content: 'Reply with exactly the word: ok' }],
    max_tokens: 512,
    stream: true,
  });

  const t0 = Date.now();
  let ttft = null, out = '', err = null, status = null;
  try {
    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...getHeaders(), 'x-hub-req-id': reqId },
      body: JSON.stringify(body),
      dispatcher,
    });
    status = res.status;
    const tHeaders = Date.now() - t0;
    if (!res.ok) {
      err = `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`;
    } else {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const p = line.slice(5).trim();
          if (p === '[DONE]') continue;
          try {
            const d = JSON.parse(p)?.choices?.[0]?.delta?.content;
            if (d) { if (ttft === null) ttft = Date.now() - t0; out += d; }
          } catch (_) {}
        }
      }
    }
    const conn = pending.get(reqId) || {};
    pending.delete(reqId);
    return {
      ttft, total: Date.now() - t0, tHeaders, status, err,
      ok: !err && /ok/i.test(out),
      reused: conn.reused ?? null, socketId: conn.socketId ?? null,
      alpn: conn.alpn ?? null, tls: conn.tls ?? null,
    };
  } catch (e) {
    pending.delete(reqId);
    return { ttft: null, total: Date.now() - t0, status, err: e.message.slice(0, 140), ok: false, reused: null };
  }
}

// ── stats ───────────────────────────────────────────────────────────────
const med = a => {
  const s = a.filter(x => typeof x === 'number').sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const p95 = a => {
  const s = a.filter(x => typeof x === 'number').sort((x, y) => x - y);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
};

// ── main ────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\nCROSS-VENDOR KEEP-ALIVE PROBE`);
  console.log(`trials/model=${TRIALS}  concurrency=1  interleaved+randomized`);
  console.log(`models: ${MODELS.join(', ')}\n`);

  // Long-lived warm pool
  const warmPool = new Agent({
    connections: 4,
    keepAliveTimeout: 60000,
    keepAliveMaxTimeout: 300000,
    headersTimeout: 600000,
    bodyTimeout: 0,
    pipelining: 1,
  });

  const rows = [];
  const skipped = [];

  // Pre-establish the warm connection so trial 1 is genuinely warm.
  process.stdout.write('warming pool... ');
  await once(MODELS[0], warmPool);
  console.log('done\n');

  for (let t = 0; t < TRIALS; t++) {
    // randomize provider order each trial
    const order = [...MODELS].sort(() => Math.random() - 0.5);
    for (const model of order) {
      // randomize cold/warm order within the pair too
      const conds = Math.random() < 0.5 ? ['cold', 'warm'] : ['warm', 'cold'];
      for (const cond of conds) {
        let disp, r;
        if (cond === 'cold') {
          disp = new Agent({ connections: 1, keepAliveTimeout: 1, pipelining: 1, headersTimeout: 600000, bodyTimeout: 0 });
          r = await once(model, disp);
          await disp.close().catch(() => {});
        } else {
          r = await once(model, warmPool);
        }
        r.model = model; r.vendor = VENDOR(model); r.cond = cond; r.trial = t;

        // Validity gate: a "warm" sample that did NOT reuse is not a warm
        // sample.  A "cold" sample that DID reuse is not cold.  Record but
        // exclude from the comparison rather than silently dropping.
        r.valid = r.ok && (cond === 'warm' ? r.reused === true : r.reused !== true);
        if (!r.valid) skipped.push(r);
        rows.push(r);
        process.stdout.write(r.ok ? (r.valid ? '.' : '!') : 'X');
      }
    }
    process.stdout.write(` t${t + 1}\n`);
  }

  console.log('\n\n=== RESULTS (valid samples only) ===\n');

  const failures = rows.filter(r => !r.ok);
  const byModel = {};
  for (const r of rows) (byModel[r.model] ||= []).push(r);

  for (const model of MODELS) {
    const all = byModel[model] || [];
    const cold = all.filter(r => r.valid && r.cond === 'cold');
    const warm = all.filter(r => r.valid && r.cond === 'warm');
    const cm = med(cold.map(r => r.ttft));
    const wm = med(warm.map(r => r.ttft));
    const cp = p95(cold.map(r => r.ttft));
    const wp = p95(warm.map(r => r.ttft));
    const saved = (cm !== null && wm !== null) ? cm - wm : null;
    const pct = saved !== null && cm ? Math.round((saved / cm) * 100) : null;
    const errC = all.filter(r => r.cond === 'cold' && !r.ok).length;
    const errW = all.filter(r => r.cond === 'warm' && !r.ok).length;
    const alpn = all.find(r => r.alpn)?.alpn || '?';
    const tls = all.find(r => r.tls)?.tls || '?';

    console.log(`${VENDOR(model)} / ${model}`);
    console.log(`   n            cold=${cold.length} warm=${warm.length}  (invalid/excluded: ${all.filter(r => r.ok && !r.valid).length})`);
    console.log(`   median ttft  cold=${cm}ms  warm=${wm}ms`);
    console.log(`   p95 ttft     cold=${cp}ms  warm=${wp}ms`);
    console.log(`   SAVED        ${saved === null ? 'n/a' : `${saved}ms  (${pct}%)`}`);
    console.log(`   errors       cold=${errC} warm=${errW}`);
    console.log(`   transport    alpn=${alpn} tls=${tls}`);
    console.log('');
  }

  // vendor rollup
  console.log('=== ABSOLUTE MS SAVED BY VENDOR (the transport claim) ===\n');
  const vendors = [...new Set(MODELS.map(VENDOR))];
  for (const v of vendors) {
    const all = rows.filter(r => r.vendor === v && r.valid);
    const cm = med(all.filter(r => r.cond === 'cold').map(r => r.ttft));
    const wm = med(all.filter(r => r.cond === 'warm').map(r => r.ttft));
    console.log(`   ${v.padEnd(10)} cold=${cm}ms warm=${wm}ms saved=${cm !== null && wm !== null ? cm - wm : 'n/a'}ms`);
  }

  if (failures.length) {
    console.log(`\n=== FAILURES (${failures.length}) ===`);
    const seen = new Set();
    for (const f of failures) {
      const k = `${f.model}|${f.cond}|${(f.err || '').slice(0, 60)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      console.log(`   ${f.model} ${f.cond}: ${f.err}`);
    }
    const fc = failures.filter(f => f.cond === 'cold').length;
    const fw = failures.filter(f => f.cond === 'warm').length;
    console.log(`   by condition: cold=${fc} warm=${fw}   (warm >> cold would indicate keep-alive harm)`);
  }

  if (skipped.length) {
    const sw = skipped.filter(s => s.cond === 'warm' && s.ok).length;
    const sc = skipped.filter(s => s.cond === 'cold' && s.ok).length;
    console.log(`\nvalidity gate excluded: ${sw} warm samples that did not reuse, ${sc} cold samples that did reuse`);
  }

  await warmPool.close().catch(() => {});
  process.exit(0);
})();
