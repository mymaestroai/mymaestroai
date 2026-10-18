'use strict';
// Claude plan on the pages: the sidebar chip, the toasts for plan_warning / plan_limit, the Settings box (windows,
// levels, the optional automatic switch, a model picker per Claude agent), and the phone's toasts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('app.js');
const html = read('index.html');
const mjs = read('mobile.js');

test('desktop: a chip in the sidebar header while a weekly allowance is past a warning level; click opens the Settings box', () => {
  assert.ok(html.includes('<span id="plan-warn" onclick="openPlanSettings()"></span>'), 'chip next to the spend readout');
  assert.ok(html.includes('#plan-warn.on { display: inline-block; }') && html.includes('#plan-warn.hot'), 'hidden until on; rose when refused');
  assert.match(app, /async function refreshPlanChip\(\) \{[\s\S]{0,500}fetch\('\/api\/plan-usage'/, 'reads GET /api/plan-usage');
  assert.ok(app.includes('if (refreshPlanChip.tries <= 8) next = Math.min(next, 15000);') && app.includes('} catch { next = 30000; }'), 'no reading yet or the hub restarting: asks again soon, not in 10 minutes');
  assert.match(app, /refreshSpendToday\(\);\s*\n\s*refreshPlanChip\(\);/, 'on page load');
  assert.ok(app.includes("'spend-today', 'plan-warn', 'hub-halt-bar'"), 'members do not see it');
  assert.ok(app.includes("el.textContent = `⚠ ${top.family ? top.label : 'Claude plan'} ${Math.round(top.utilization)}%`;"), 'label "⚠ Fable 90%"');
});

test('desktop: no pop-up for plan events; a usage badge next to each Claude agent\'s model; brief toasts sit near the top', () => {
  assert.ok(app.includes("source.addEventListener('plan_warning', e => { const ev = parse(e); if (!ev) return; refreshPlanChip();"), 'plan_warning refreshes, no toast');
  assert.ok(!/addEventListener\('plan_(warning|limit)'[^\n]*hubToast/.test(app), 'no toast for plan events');
  assert.ok(app.includes('<span class="plan-badge" id="plan-badge-${chatId}" hidden onclick="openPlanSettings()"></span>'), 'badge in the chat header after the effort picker');
  assert.ok(app.includes("el.textContent = `${w.family ? w.label : 'Plan'} ${pct}% this week`;"), 'label "Fable 90% this week"');
  assert.match(app, /compactionRefresh\(chatId\);[^\n]*\n\s*paintPlanBadges\(\);/, 'painted when a chat opens');
  assert.match(app, /refreshEffortPick\(chat\);\s*\n\s*paintPlanBadges\(\);/, 'and when the agent\'s model changes');
  assert.ok(app.includes('paintPlanChip(); paintPlanBadges();'), 'and with every new reading');
  assert.ok(html.includes('.chat-actions .plan-badge {') && html.includes('.chat-actions .plan-badge.warn') && html.includes('.chat-actions .plan-badge.refused'), 'styled');
  assert.ok(html.includes('#hub-toast { position: fixed; left: 50%; top: 150px;'), 'toasts no longer cover the input');
});

test('desktop: Settings → Claude plan: windows, warning levels, the automatic switch (off), a model picker per agent', () => {
  assert.ok(app.includes('<div class="st-section" id="st-plan-section"><h4>Claude plan</h4>') && app.includes('setTimeout(loadPlanBox, 0);'), 'box');
  assert.ok(app.includes('id="st-plan-warn"') && app.includes("JSON.stringify({ planWarn: { at } })"), 'levels saved through POST /api/settings');
  assert.ok(app.includes('id="st-plan-auto"') && app.includes('JSON.stringify({ planFallback: { enabled: !!on } })'), 'automatic switch toggle');
  assert.ok(app.includes('onchange="planAgentModel(this)"') && app.includes("fetch(`/api/agents/${encodeURIComponent(agent)}/model`, { method: 'POST'"), 'per-agent picker uses the model route');
  assert.ok(app.includes("await fetch(readNow ? '/api/plan-usage/refresh' : '/api/plan-usage'"), 'read now');
});

test('phone: plan usage in the chat header for Claude agents; no plan pop-ups', () => {
  const mhtml = read('mobile.html');
  assert.ok(mhtml.includes('<span class="sub" id="chat-plan" hidden></span>') && mhtml.includes('#chat-plan.warn'), 'header element + style');
  assert.ok(mjs.includes("on('plan_limit', () => refreshPlanUsage());") && mjs.includes("on('plan_warning', () => refreshPlanUsage());"), 'events refresh, no toast');
  assert.ok(mjs.includes("el.textContent = `${w.family ? w.label : 'Plan'} ${pct}%`;"), 'label "Fable 90%"');
  assert.match(mjs, /await loadMe\(\);\s*\n\s*applyMultiUser\(\);\s*\n\s*refreshPlanUsage\(\);/, 'read at start');
  assert.ok(mjs.includes('paintCtx(); refreshCtx(name); paintPlan();'), 'painted on open');
  assert.ok(mjs.includes('if (refreshPlanUsage.tries <= 8) next = Math.min(next, 15000);'), 'asks again soon while the hub has no reading yet');
  assert.ok(mjs.includes('function toast(text, ms = 3000) {'), 'toast duration kept');
});

test('both chat renderers show a whole line in underscores (the hub\'s notices) in italics', () => {
  const rule = ".replace(/(^|\\n)_(?=[^\\s_])([^\\n]*?[^\\s_])_(?=\\n|$)/g, '$1<em>$2</em>');";
  assert.ok(app.includes(rule), 'desktop formatContent');
  assert.ok(mjs.includes(rule), 'phone formatContent');
  const re = /(^|\n)_(?=[^\s_])([^\n]*?[^\s_])_(?=\n|$)/g;
  assert.strictEqual('_⚠️ Fable has used 90% (resets Wed 8:00 PM)._\n\nOK.'.replace(re, '$1<em>$2</em>'), '<em>⚠️ Fable has used 90% (resets Wed 8:00 PM).</em>\n\nOK.');
  assert.strictEqual('__TABLE_TOKEN_0__'.replace(re, '$1<em>$2</em>'), '__TABLE_TOKEN_0__', 'placeholders untouched');
  assert.strictEqual('see my_file_name here'.replace(re, '$1<em>$2</em>'), 'see my_file_name here', 'snake_case untouched');
});
