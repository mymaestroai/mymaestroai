#!/usr/bin/env node
'use strict';

/**
 * model-report.js — print per-model reliability + tool-calling telemetry
 *
 * Usage:
 *   node scripts/model-report.js               # last 7 days
 *   node scripts/model-report.js --hours 24
 *   node scripts/model-report.js --tools
 *   node scripts/model-report.js --tools --model claude-opus-5
 *   node scripts/model-report.js --conn --hours 24
 *   node scripts/model-report.js --before-after "2026-08-05 21:30:00"
 *   node scripts/model-report.js --purge 90
 */

const tel = require('../lib/model-telemetry');

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d;
};

const hours = parseInt(flag('hours', '168'), 10);

if (flag('purge')) {
  const days = parseInt(flag('purge', '90'), 10);
  console.log(`Purged ${tel.purgeOlderThan(days)} rows older than ${days} days.`);
  process.exit(0);
}

function table(rows, cols) {
  if (!rows.length) return '(no data)';
  const w = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '-').length)));
  const line = (vals) => vals.map((v, i) => String(v ?? '-').padEnd(w[i])).join('  ');
  return [line(cols), w.map(n => '-'.repeat(n)).join('  '),
          ...rows.map(r => line(cols.map(c => Array.isArray(r[c]) ? r[c].join(',') : r[c])))].join('\n');
}

if (flag('conn')) {
  const model = flag('model', null);
  const m = typeof model === 'string' ? model : null;
  const { rows, overall, proto } = tel.connReport(hours, m);
  console.log(`\nGATEWAY CONNECTION REUSE — last ${hours}h${m ? ` — ${m}` : ''}\n`);
  if (!rows.length) {
    console.log('(no connection telemetry yet — requires the keep-alive build and fresh traffic)');
  } else {
    console.log(table(rows, ['model', 'requests', 'reused', 'reuse_pct', 'ttft_warm_ms', 'ttft_cold_ms', 'connect_ms']));
    console.log(`\nOVERALL: ${overall.requests} reqs, ${overall.reuse_pct}% reused, ${overall.sockets} distinct sockets`);
    console.log(`  ttft warm ${overall.ttft_warm_ms ?? '-'}ms vs cold ${overall.ttft_cold_ms ?? '-'}ms`);
    if (overall.ttft_warm_ms && overall.ttft_cold_ms) {
      console.log(`  saving per warm request: ${overall.ttft_cold_ms - overall.ttft_warm_ms}ms`);
    }
    console.log('\nNEGOTIATED PROTOCOL:');
    for (const p of proto) console.log(`  alpn=${p.alpn || '-'} tls=${p.tls_version || '-'}  n=${p.n}`);
  }
} else if (flag('before-after')) {
  const cutover = flag('before-after');
  if (cutover === true) {
    console.log('Usage: --before-after "2026-08-05 21:30:00" [--model X] [--hours N]');
    process.exit(1);
  }
  const model = flag('model', null);
  const r = tel.beforeAfter(cutover, hours, typeof model === 'string' ? model : null);
  console.log(`\nBEFORE / AFTER cutover ${r.cutover} — model ${r.model} — window ${hours}h\n`);
  for (const side of ['before', 'after']) {
    const s = r[side];
    console.log(`  ${side.toUpperCase().padEnd(7)} reqs ${String(s.requests).padStart(5)}  ` +
      `median ttft ${String(s.median_ttft_ms ?? '-').padStart(6)}ms  avg ttft ${String(s.avg_ttft_ms ?? '-').padStart(6)}ms  ` +
      `avg total ${String(s.avg_total_ms ?? '-').padStart(7)}ms  ok ${s.ok_pct ?? '-'}%  empty ${s.empty ?? 0}`);
  }
  const b = r.before.median_ttft_ms, a = r.after.median_ttft_ms;
  if (b && a) console.log(`\n  median ttft delta: ${b - a}ms (${((1 - a / b) * 100).toFixed(0)}% faster)`);
  console.log('  NOTE: only valid if nothing else changed at the cutover.  Prefer --conn for the causal signal.');
} else if (flag('tools')) {
  const model = flag('model', null);
  const rows = tel.toolReport(hours, typeof model === 'string' ? model : null);
  console.log(`\nTOOL EXECUTION — last ${hours}h${typeof model === 'string' ? ` — ${model}` : ''}\n`);
  console.log(table(rows, Object.keys(rows[0] || { tool: '' })));
} else {
  const rows = tel.modelReport(hours);
  console.log(`\nMODEL RELIABILITY — last ${hours}h\n`);
  console.log(table(rows, ['model', 'requests', 'ok_pct', 'avg_ttft_ms', 'avg_total_ms',
                           'tool_calls', 'malformed_args', 'empty', 'tool_exec_ok_pct', 'errors']));
  const bad = tel.unhealthyModels(hours);
  if (bad.length) {
    console.log(`\nUNHEALTHY (>=5 reqs, <85% ok):\n`);
    console.log(table(bad, ['model', 'requests', 'ok_pct', 'errors']));
  }
}
console.log('');
