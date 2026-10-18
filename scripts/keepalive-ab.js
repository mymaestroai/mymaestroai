#!/usr/bin/env node
/**
 * keepalive-ab.js — A/B efficacy test for the gateway keep-alive pool (P0).
 *
 * Runs the REAL lib/gateway-client.js in two child processes:
 *   OFF: GATEWAY_KEEPALIVE=0  (pre-fix behavior, bare global fetch)
 *   ON : GATEWAY_KEEPALIVE=1  (undici keep-alive dispatcher)
 *
 * Two child processes are used deliberately — the dispatcher is decided at
 * module load, so a single process cannot honestly test both.
 *
 * Reports MEDIAN ttft (averages get destroyed by cold-start outliers), the
 * warm-only median (excluding request #1, which must pay the handshake in
 * both arms), correctness, and observed socket reuse.
 *
 * Usage:
 *   node scripts/keepalive-ab.js                       # default 3 models x 6 reqs
 *   node scripts/keepalive-ab.js 8 claude-opus-5,gpt-5.5
 *   KA_CHAIN=1 node scripts/keepalive-ab.js            # also run a 9-hop chain sim
 */

require('dotenv').config();
const { fork } = require('child_process');
const path = require('path');

const REQS = Number(process.argv[2] || 6);
const MODELS = (process.argv[3] || 'claude-opus-5,claude-sonnet-5,gpt-5.5').split(',');

// ── Child mode ──────────────────────────────────────────────────────────
if (process.env.KA_CHILD === '1') {
  const gw = require('../lib/gateway-client');
  const httpAgent = require('../lib/http-agent');

  (async () => {
    const models = process.env.KA_MODELS.split(',');
    const reqs = Number(process.env.KA_REQS);
    const results = [];
    for (const model of models) {
      for (let i = 0; i < reqs; i++) {
        const t0 = Date.now();
        let ttft = null, out = '', err = null;
        try {
          const resp = await gw.chatCompletionStream(
            [{ role: 'user', content: 'Reply with exactly the word: ok' }],
            { model, max_tokens: 512 }
          );
          const conn = resp.__hubConn || {};
          for await (const chunk of gw.parseSSEStream(resp)) {
            const d = chunk?.choices?.[0]?.delta?.content;
            if (d) { if (ttft === null) ttft = Date.now() - t0; out += d; }
          }
          results.push({
            model, i, ttft, total: Date.now() - t0,
            ok: /ok/i.test(out), len: out.length,
            reused: conn.connReused ?? null, socket: conn.socketId ?? null,
            alpn: conn.alpn ?? null, tls: conn.tlsVersion ?? null,
          });
        } catch (e) {
          err = e.message.slice(0, 160);
          results.push({ model, i, err });
        }
      }
    }
    process.send({ results, stats: httpAgent.stats() });
    await httpAgent.close();
    process.exit(0);
  })();
  return;
}

// ── Parent mode ─────────────────────────────────────────────────────────

function runArm(keepalive) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'keepalive-ab.js'), [], {
      env: {
        ...process.env,
        KA_CHILD: '1',
        KA_MODELS: MODELS.join(','),
        KA_REQS: String(REQS),
        GATEWAY_KEEPALIVE: keepalive ? '1' : '0',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let payload = null;
    child.on('message', (m) => { payload = m; });
    child.stderr.on('data', d => process.stderr.write(`  [child] ${d}`));
    child.on('exit', (code) => payload ? resolve(payload)
      : reject(new Error(`arm exited ${code} with no payload`)));
    setTimeout(() => { try { child.kill(); } catch (_) {} }, 300000);
  });
}

const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function summarize(label, payload) {
  const rows = payload.results;
  console.log(`\n=== ${label} ===`);
  for (const model of MODELS) {
    const r = rows.filter(x => x.model === model);
    const good = r.filter(x => x.ttft != null);
    const fails = r.filter(x => x.err);
    if (!good.length) { console.log(`  ${model.padEnd(20)} ALL FAILED  ${fails[0]?.err || ''}`); continue; }
    const warm = good.filter(x => x.i > 0).map(x => x.ttft);
    const reused = good.filter(x => x.reused === true).length;
    console.log(
      `  ${model.padEnd(20)} median ${String(median(good.map(x => x.ttft))).padStart(6)}ms  ` +
      `warm-median ${String(median(warm) ?? '-').padStart(6)}ms  ` +
      `correct ${good.filter(x => x.ok).length}/${r.length}  ` +
      `errors ${fails.length}  reused ${reused}/${good.length}  ` +
      `sockets ${new Set(good.map(x => x.socket).filter(Boolean)).size || '-'}  ` +
      `[${good.map(x => x.ttft).join('/')}]`
    );
  }
  const s = payload.stats;
  console.log(`  pool: enabled=${s.enabled} opened=${s.connectionsOpened} reuse=${s.reusePct ?? '-'}% ` +
              `connErrors=${s.connectionErrors} disconnects=${s.disconnects}`);
  const proto = rows.find(r => r.alpn || r.tls);
  if (proto) console.log(`  negotiated: alpn=${proto.alpn} tls=${proto.tls}`);
  return rows;
}

(async () => {
  console.log(`keep-alive A/B  models=${MODELS.join(',')}  requests/model=${REQS}`);
  console.log('Running OFF arm first (cold), then ON arm.  Order is then reversed to control for warmup.');

  const off1 = await runArm(false);
  const on1 = await runArm(true);
  // Reverse order to cancel any network-warmup drift favoring the second arm.
  const on2 = await runArm(true);
  const off2 = await runArm(false);

  const offRows = [...summarize('OFF (bare fetch) — pass 1', off1), ...summarize('OFF (bare fetch) — pass 2', off2)];
  const onRows = [...summarize('ON (keep-alive) — pass 1', on1), ...summarize('ON (keep-alive) — pass 2', on2)];

  console.log('\n=== VERDICT (both passes pooled) ===');
  let anyRegression = false;
  for (const model of MODELS) {
    const o = offRows.filter(x => x.model === model && x.ttft != null);
    const n = onRows.filter(x => x.model === model && x.ttft != null);
    if (!o.length || !n.length) { console.log(`  ${model}: insufficient data`); continue; }
    const ow = median(o.filter(x => x.i > 0).map(x => x.ttft));
    const nw = median(n.filter(x => x.i > 0).map(x => x.ttft));
    const delta = ow && nw ? ow - nw : null;
    const pct = ow && nw ? ((1 - nw / ow) * 100).toFixed(0) : '-';
    const oErr = offRows.filter(x => x.model === model && x.err).length;
    const nErr = onRows.filter(x => x.model === model && x.err).length;
    const oOk = o.filter(x => x.ok).length, nOk = n.filter(x => x.ok).length;
    if (nErr > oErr || (nOk / n.length) < (oOk / o.length)) anyRegression = true;
    console.log(`  ${model.padEnd(20)} warm-median ${String(ow).padStart(6)} -> ${String(nw).padStart(6)}ms  ` +
                `saved ${String(delta).padStart(5)}ms (${pct}%)  correctness ${oOk}/${o.length} -> ${nOk}/${n.length}  errors ${oErr} -> ${nErr}`);
  }
  console.log(anyRegression
    ? '\n  ⚠️  QUALITY REGRESSION DETECTED in the ON arm — do not ship.'
    : '\n  No correctness or error-rate regression in the ON arm.');
})();
