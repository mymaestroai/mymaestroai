'use strict';
// Wiring of the component watch: sdk-chat codexInUse, server.js routes and setting, app.js Settings → Status (source checks).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const server = read('server.js');
const app = read('app.js');
const sdk = read('lib/sdk-chat.js');

test('sdk-chat exports codexInUse: running names, workers by their own model, true on error', () => {
  const at = sdk.indexOf('function codexInUse()');
  assert.ok(at > 0);
  const body = sdk.slice(at, sdk.indexOf('\n}\n', at));
  assert.match(body, /pendingChatRequests/);
  assert.match(body, /activeResponses\.keys\(\)/);
  assert.match(body, /resolveVirtualAgent\(n\)/);
  assert.match(body, /v \? v\.model/);
  assert.match(body, /getAgentsSync\(\)/);
  assert.match(body, /startsWith\('codex-cli\/'\)/);
  assert.match(body, /catch \{ return true; \}/);
  assert.match(sdk, /module\.exports = \{[\s\S]*\n  codexInUse,/);
});

test('server.js: one watch with the hub deps, started after listen next to the update check', () => {
  assert.match(server, /function componentWatch\(\) \{/);
  assert.match(server, /createComponentWatch\(\{\s*codexInUse: \(\) => require\('\.\/lib\/sdk-chat'\)\.codexInUse\(\),\s*claudeOffered: \(\) => require\('\.\/lib\/claude-offered'\)\.claudeOffered\(\{ root: __dirname, updateStatus:/);
  const upd = server.indexOf("require('./lib/update-check').getUpdateCheck().start()");
  const cw = server.indexOf('componentWatch().start()');
  assert.ok(upd > 0 && cw > upd, 'started right after the update check');
  assert.ok(cw > server.indexOf('server.listen(PORT, HOST'), 'inside the listen callback');
  assert.match(server, /getHubMap\(\)\.init\(\{ components: \(\) => componentWatch\(\)\.items\(\)/);
});

test('server.js routes: GET items + setting, POST check, POST codex/update 200 or 409; admin by the route class', () => {
  assert.match(server, /pathname === '\/api\/components' && req\.method === 'GET'[\s\S]{0,200}items: componentWatch\(\)\.items\(\), setting: \{ codex:/);
  assert.match(server, /pathname === '\/api\/components\/check' && req\.method === 'POST'[\s\S]{0,200}check\(\{ reason: 'manual' \}\)/);
  assert.match(server, /pathname === '\/api\/components\/codex\/update' && req\.method === 'POST'[\s\S]{0,300}updateCodexNow\(\)[\s\S]{0,300}r && r\.ok \? 200 : 409/);
  const access = require('../lib/access');
  for (const p of ['/api/components', '/api/components/check', '/api/components/codex/update']) assert.equal(access.classifyRoute(p, 'GET').kind, 'admin');
});

test('server.js /api/settings: componentUpdates is cleaned to one of auto, notify, off', () => {
  assert.ok(server.includes("if (patch && patch.componentUpdates !== undefined) patch.componentUpdates = { codex: ['auto', 'notify', 'off'].includes(patch.componentUpdates && patch.componentUpdates.codex) ? patch.componentUpdates.codex : 'auto' };"));
  assert.ok(server.indexOf('patch.componentUpdates !== undefined') > server.indexOf('patch.modelOffers !== undefined'));
});

test('app.js: the section is in the Status group before st-updates-section, admin-gated', () => {
  const m = app.match(/\{ id: 'status', title: '[^']*', sections: \[([^\]]*)\] \}/);
  const ids = m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.ok(ids.indexOf('st-components-section') > 0 && ids.indexOf('st-components-section') === ids.indexOf('st-updates-section') - 1);
  assert.equal(ids[ids.length - 1], 'st-updates-section');
  const at = app.indexOf('id="st-components-section"');
  assert.ok(at > 0);
  assert.match(app.slice(app.lastIndexOf('\n', at - 200) - 200, at), /if \(isHubAdmin\(\)\) \{\s*html \+= `<div class="st-section" $/);
  assert.match(app.slice(at, at + 200), /Software your Maestro relies on/);
  assert.ok(at < app.indexOf('id="st-updates-section"'));
});

test('app.js: server text goes through escapeHtml; the buttons post to the right routes', () => {
  const a = app.indexOf('function paintComponents(data)');
  const b = app.indexOf('async function checkUpdatesNow(');
  const src = app.slice(a, b);
  for (const f of ['it.name', 'it.installed', 'it.latest', 'it.how', 'it.waiting', 'lu.from', 'lu.to']) assert.ok(src.includes(`escapeHtml(${f}`), `${f} escaped`);
  assert.doesNotMatch(src, /\$\{it\.(name|how|installed|latest|waiting)\}/);
  assert.match(src, /fetch\('\/api\/components', \{ credentials: 'include' \}\)/);
  assert.match(src, /fetch\('\/api\/components\/check', \{ method: 'POST'/);
  assert.match(src, /fetch\('\/api\/components\/codex\/update', \{ method: 'POST'/);
  assert.match(src, /fetch\('\/api\/settings', \{ method: 'POST'[^\n]*JSON\.stringify\(\{ componentUpdates: \{ codex: value \} \}\)/);
  assert.match(src, /Automatic[\s\S]*Tell me[\s\S]*Off/);
  assert.match(src, /codex\.behind && cur !== 'off'[\s\S]{0,200}Update Codex now/);
  assert.match(src, /onclick="checkComponentsNow\(this\)"|checkComponentsNow/);
  assert.ok(!src.includes(String.fromCharCode(0xFE0F)), 'no U+FE0F');
});

test('lead: with Codex updates Off, Settings → Status still shows the Codex select so they can be switched on again', () => {
  const app = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
  const body = app.slice(app.indexOf('function paintComponents('), app.indexOf('async function loadComponents('));
  assert.match(body, /if \(!codex && cur !== 'off'\) \{ codexBox\.innerHTML = ''; return; \}/);
  assert.match(body, /codex && codex\.behind && cur !== 'off'/);
});
