'use strict';
// The Settings panel folds its sections into six groups that start closed, each with a one-line summary, a search
// box, remembered open groups, and links into Settings that open the right group first. Source-level checks on
// app.js / index.html (the page is not run here).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function settingsSource(app) {
  const start = app.indexOf('async function openSettings() {');
  const end = app.indexOf('// Auto model classifier (lib/classifier): settings', start);
  assert.ok(start > 0 && end > start, 'openSettings() found');
  return app.slice(start, end);
}

function groupsFromSource(app) {
  const m = app.match(/const ST_GROUPS = \[([\s\S]*?)\n\s*\];/);
  assert.ok(m, 'ST_GROUPS found');
  const groups = [];
  for (const g of m[1].matchAll(/\{ id: '([a-z]+)', title: '([^']+)', sections: \[([^\]]*)\] \}/g)) {
    groups.push({ id: g[1], title: g[2], sections: [...g[3].matchAll(/'([^']+)'/g)].map(x => x[1]) });
  }
  return groups;
}

test('six groups, and every section openSettings draws belongs to exactly one of them', () => {
  const app = read('app.js');
  const groups = groupsFromSource(app);
  assert.deepStrictEqual(groups.map(g => g.title), ['🩺 Status', '🧠 AI models', '🤖 Agents', '🔔 Notifications', '🧰 Tools and data', '💰 Money and safety']);
  const src = settingsSource(app);
  const drawn = [...src.matchAll(/class="st-section" id="(st-[a-z0-9-]+-section)"/g)].map(m => m[1]);
  assert.strictEqual(drawn.length, 17, 'all 17 sections carry an id');
  assert.doesNotMatch(src, /class="st-section">/, 'no section without an id');
  const grouped = groups.flatMap(g => g.sections);
  assert.strictEqual(new Set(grouped).size, grouped.length, 'no section in two groups');
  assert.deepStrictEqual([...grouped].sort(), [...drawn].sort(), 'the groups name exactly the sections drawn');
  const byId = Object.fromEntries(groups.map(g => [g.id, g.sections]));
  assert.deepStrictEqual(byId.status, ['st-ready-section', 'st-sec-section']);
  assert.deepStrictEqual(byId.money, ['st-spend-section', 'st-emergency-section']);
  assert.ok(byId.models.includes('st-plan-section') && byId.models.includes('st-or-section') && byId.models.includes('st-prov-section'));
  assert.ok(byId.agents.includes('st-sb-section') && byId.agents.includes('st-approvals-section'));
  assert.ok(byId.tools.includes('st-ws-section') && byId.tools.includes('st-cx-section'));
});

test('the panel is grouped right after it is drawn; groups start closed unless this browser left them open', () => {
  const app = read('app.js');
  assert.match(settingsSource(app), /stModal\(html\);\s*groupSettings\(data\);/);
  assert.match(app, /localStorage\.getItem\('hub-settings-open'\)/);
  assert.match(app, /localStorage\.setItem\('hub-settings-open', JSON\.stringify\(open\)\)/);
  assert.match(app, /<details class="st-group" id="st-group-\$\{g\.id\}" data-group="\$\{g\.id\}"\$\{saved\[g\.id\] \? ' open' : ''\}>/);
  // A section the list doesn't know yet lands in the last group instead of disappearing
  assert.match(app, /for \(const s of sections\) if \(!placed\.has\(s\)\) body\(ST_GROUPS\[ST_GROUPS\.length - 1\]\.id\)\.appendChild\(s\);/);
  // Opening by search, a link or a critical finding is not remembered as the person's choice
  assert.match(app, /if \(d\.dataset\.auto\) \{ delete d\.dataset\.auto; return; \}\s*if \(!stSearchSnap\) stSaveOpen\(\);/);
});

test('search shows matching sections, opens their groups, and clearing it puts the groups back', () => {
  const app = read('app.js');
  assert.match(app, /<input type="search" id="st-search"/);
  assert.match(app, /input\.addEventListener\('input', \(\) => stSearch\(input\.value\)\);/);
  assert.match(app, /if \(!stSearchSnap\) \{ stSearchSnap = \{\}; for \(const g of groups\) stSearchSnap\[g\.dataset\.group\] = g\.open; \}/);
  assert.match(app, /if \(stSearchSnap\) stSetOpen\(g, !!stSearchSnap\[g\.dataset\.group\]\);/);
  assert.match(app, /const titleHit = g\.querySelector\('\.st-group-title'\)\.textContent\.toLowerCase\(\)\.includes\(q\);/);
  assert.match(app, /if \(none\) none\.hidden = any;/);
});

test('each group header carries a summary that the section loaders fill in; Status opens itself on a critical finding', () => {
  const app = read('app.js');
  for (const [group, key] of [['status', 'setup'], ['status', 'security'], ['models', 'plan'], ['models', 'or'], ['models', 'local'], ['notify', 'push'], ['tools', 'search'], ['tools', 'cx'], ['money', 'spend'], ['money', 'caps']]) {
    assert.ok(app.includes(`stSum('${group}', '${key}', `), `${group}/${key} summary is set`);
  }
  assert.match(app, /stSum\('status', 'setup', d\.critical \? `Setup: \$\{d\.critical\} to fix`[^\n]*, !!d\.critical\);\s*if \(d\.critical\) stOpenGroup\('status'\);/);
  assert.match(app, /stSum\('status', 'security', d\.critical \? `Security: \$\{d\.critical\} critical`[^\n]*, !!d\.critical\);\s*if \(d\.critical\) stOpenGroup\('status'\);/);
  assert.match(app, /el\.classList\.toggle\('st-sum-crit', parts\.some\(p => p\.crit && p\.text\)\);/);
});

test('links into Settings open the group that holds their section', () => {
  const app = read('app.js');
  assert.match(app, /async function openSettingsAt\(sectionId\) \{\s*await openSettings\(\);[\s\S]{0,120}stSetOpen\(s\.closest\('details\.st-group'\), true\);/);
  assert.match(app, /async function openPlanSettings\(\) \{\s*await openSettingsAt\('st-plan-section'\);/);
  assert.ok(app.includes(`onclick="openSettingsAt('st-ready-section'); return false"`), 'setup banner');
  assert.ok(app.includes(`onclick="openSettingsAt('st-sec-section'); return false"`), 'security banner');
  assert.ok(read('index.html').includes(`id="spend-today" onclick="openSettingsAt('st-spend-section')"`), "today's spend chip");
});

test('group styles: no browser marker, a turning arrow, one-line summaries', () => {
  const html = read('index.html');
  assert.match(html, /details\.st-group > summary \{\s*list-style: none;/);
  assert.match(html, /details\.st-group > summary::-webkit-details-marker \{ display: none; \}/);
  assert.match(html, /details\.st-group\[open\] > summary::before \{ transform: rotate\(90deg\); \}/);
  assert.match(html, /\.st-group-sum \{[^}]*text-overflow: ellipsis; white-space: nowrap;/);
});
