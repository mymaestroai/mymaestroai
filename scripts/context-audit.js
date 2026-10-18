#!/usr/bin/env node
/**
 * context-audit.js — measures per-agent prompt context size.
 *
 * Usage:
 *   node scripts/context-audit.js              # all agents
 *   node scripts/context-audit.js main cos     # specific agents
 *
 * Reports personality/memory bytes and tool-payload bytes (raw vs sanitized).
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getAgents, loadAgentContext } = require('../lib/agents');
const gw = require('../lib/gateway-client');

const KB = (n) => (n / 1024).toFixed(1) + ' KB';
const TOK = (n) => Math.round(n / 4).toLocaleString(); // ~4 bytes/token rough

function bytes(s) { return Buffer.byteLength(s || '', 'utf8'); }

async function main() {
  const wanted = process.argv.slice(2);
  const agents = await getAgents();
  const list = wanted.length
    ? agents.filter(a => wanted.includes(a.name))
    : agents;

  // ── Tool payload measurement ──────────────────────────────────────────
  let toolRows = [];
  try {
    const { getSkillTools } = require('../lib/skills/skill-manager');
    const pt = require('../lib/provider-tools');
    const { openaiTools: mcpTools } = await getSkillTools();
    const providerTools = Object.entries(pt.BUILTIN_TOOLS || {})
      .map(([n, d]) => pt.builtinToolToOpenAI(n, d));
    const all = [...(mcpTools || []), ...providerTools];
    if (all && all.length) {
      const raw = bytes(JSON.stringify(all));
      const sanitized = gw.sanitizeTools(all);
      toolRows.push({ label: `full set (${all.length} tools)`, raw, san: bytes(JSON.stringify(sanitized)) });

      // lazy-loading baseline — what a first turn actually ships
      const src = require('fs').readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
      const ALWAYS = JSON.parse(src.match(/const ALWAYS_INCLUDE = (\[[^\]]+\])/)[1].replace(/'/g, '"'));
      const catBlock = src.match(/const TOOL_CATEGORIES = \{[\s\S]*?\n\};/)[0];
      const CATS = eval('(' + catBlock.replace('const TOOL_CATEGORIES = ', '').replace(/;$/, '') + ')');
      const active = new Set(ALWAYS);
      const uncat = [];
      const base = sanitized.filter(t => {
        const n = t.function?.name || t.name;
        if (n === 'request_tools') return true;
        let c = false;
        for (const [k, r] of Object.entries(CATS)) {
          if (r.test(n)) { c = true; if (active.has(k)) return true; }
        }
        if (!c) uncat.push(n);
        return !c;
      });
      const lazyBytes = bytes(JSON.stringify(base));
      toolRows.push({ label: `lazy baseline (${base.length} tools)`, raw, san: lazyBytes });
      global.__lazyBytes = lazyBytes;
      if (uncat.length) {
        global.__uncat = [...new Set(uncat.map(n => n.split('__')[0]))];
      }
    }
  } catch (e) {
    toolRows.push({ label: 'tool load failed: ' + e.message, raw: 0, san: 0 });
  }

  console.log('\n=== TOOL PAYLOAD ===');
  for (const r of toolRows) {
    const pct = r.raw ? (100 - (r.san / r.raw) * 100).toFixed(0) : 0;
    console.log(`${r.label.padEnd(40)} raw ${KB(r.raw).padStart(10)}  →  sanitized ${KB(r.san).padStart(10)}  (-${pct}%)`);
  }

  // ── Per-agent context ─────────────────────────────────────────────────
  console.log('\n=== AGENT CONTEXT (personality + memory) ===');
  console.log('agent'.padEnd(20) + 'bytes'.padStart(12) + '~tokens'.padStart(12) + '  memory');
  console.log('-'.repeat(64));

  const results = [];
  for (const a of list) {
    try {
      const ctx = await loadAgentContext(a.name, 'hub', {});
      const total = bytes(ctx);
      // isolate the memory block
      const memIdx = ctx.indexOf('# Long-Term Memory');
      const memBytes = memIdx >= 0 ? total - memIdx : 0;
      results.push({ name: a.name, total, memBytes });
    } catch (e) {
      results.push({ name: a.name, total: -1, memBytes: 0, err: e.message });
    }
  }

  results.sort((x, y) => y.total - x.total);
  for (const r of results) {
    if (r.total < 0) { console.log(`${r.name.padEnd(20)} ERROR: ${r.err}`); continue; }
    console.log(
      r.name.padEnd(20) +
      KB(r.total).padStart(12) +
      TOK(r.total).padStart(12) +
      '  ' + KB(r.memBytes)
    );
  }

  const maxCtx = Math.max(...results.map(r => r.total));
  const fullTools = toolRows[0]?.san || 0;
  const lazyTools = global.__lazyBytes || 0;
  console.log('-'.repeat(64));
  console.log(`TYPICAL first turn  ≈ ${KB(maxCtx + lazyTools).padStart(9)}  (~${TOK(maxCtx + lazyTools)} tokens)   ctx ${KB(maxCtx)} + lazy tools ${KB(lazyTools)}`);
  console.log(`CEILING all tools   ≈ ${KB(maxCtx + fullTools).padStart(9)}  (~${TOK(maxCtx + fullTools)} tokens)   ctx ${KB(maxCtx)} + full tools ${KB(fullTools)}`);
  if (global.__uncat) {
    console.log(`\n⚠️  UNCATEGORIZED skills bypassing lazy loading: ${global.__uncat.join(', ')}`);
    console.log('   Add regexes to TOOL_CATEGORIES in lib/sdk-chat.js.');
  } else {
    console.log('\n✅ No uncategorized tools — lazy loading fully effective.');
  }
  console.log('');

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
