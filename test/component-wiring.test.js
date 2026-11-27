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
  assert.match(server, /pathname === '\/api\/components\/check' && req\.method === 'POST'[\s\S]{0,200}check\(\{ reason: 'manual', allowUpdate: false \}\)/);
  assert.match(server, /pathname === '\/api\/components\/codex\/update' && req\.method === 'POST'[\s\S]{0,300}canUpdateCodexNow\(\)[\s\S]{0,300}409[\s\S]{0,300}updateCodexNow\(\)[\s\S]{0,300}202, \{ started: true \}/);
  const access = require('../lib/access');
  for (const p of ['/api/components', '/api/components/check', '/api/components/codex/update']) assert.equal(access.classifyRoute(p, 'GET').kind, 'admin');
});

test('server.js: the update route does not await the update, the check route is a look only', () => {
  const at = server.indexOf("pathname === '/api/components/codex/update'");
  const route = server.slice(at, server.indexOf('// ── Memory health', at));
  assert.match(route, /componentWatch\(\)\.updateCodexNow\(\)\.catch\(/);
  assert.doesNotMatch(route, /await componentWatch\(\)\.updateCodexNow/);
  assert.match(route, /jsonResponse\(res, 202, \{ started: true \}\)/);
  const chk = server.slice(server.indexOf("pathname === '/api/components/check'"), at);
  assert.match(chk, /allowUpdate: false/);
});

test('app.js updateCodexNow: 202 shows Updating Codex, polls every 3 s for 15 minutes, then reports lastUpdate; 409 shows the error', () => {
  const body = app.slice(app.indexOf('async function updateCodexNow('), app.indexOf('async function checkUpdatesNow('));
  assert.match(body, /r\.status === 202/);
  assert.match(body, /Updating Codex…/);
  assert.match(body, /15 \* 60 \* 1000/);
  assert.match(body, /setTimeout\(ok, 3000\)/);
  assert.match(body, /fetch\('\/api\/components', \{ credentials: 'include' \}\)/);
  assert.match(body, /Number\(l\.at\) > baseline/);
  assert.match(body, /Codex updated\$\{lu\.to/);
  assert.match(body, /Codex was not updated: \$\{lu\.error/);
  assert.match(body, /j\.error/);
  assert.ok(!body.includes(String.fromCharCode(0xFE0F)), 'no U+FE0F');
});

test('sdk-chat: a Codex turn waits for the update lock right before the binary is resolved', () => {
  assert.match(sdk, /const codexUpdateLock = require\('\.\/codex-cli\/update-lock'\);/);
  const at = sdk.indexOf('async function streamViaCodex(');
  assert.ok(at > 0);
  const bin = sdk.indexOf('const bin = codexCli.resolveBinary();', at);
  assert.ok(bin > at);
  const gate = sdk.indexOf("if (typeof codexUpdateLock !== 'undefined' && codexUpdateLock && codexUpdateLock.active()) {", at);
  assert.ok(gate > at && gate < bin, 'the wait comes before the binary is resolved');
  // review r4: after the headers and the Stop listener, so the page sees the turn and Stop ends the wait
  const head = sdk.indexOf("res.writeHead(200", at), abortAt = sdk.indexOf("signal.addEventListener('abort'", at);
  assert.ok(head > at && head < gate && abortAt > at && abortAt < gate);
  const block = sdk.slice(gate, bin);
  assert.match(block, /setInterval\([^]*heartbeat/, 'a heartbeat while it waits');
  assert.match(block, /await codexUpdateLock\.waitIdle\(20 \* 60 \* 1000, signal\)/);
  assert.match(block, /if \(!idle \|\| \(signal && signal\.aborted\)\) \{[^]*sendSSEDone\(res\);[^]*return;/, 'a turn that waited in vain, or was stopped, ends instead of starting Codex');
});

test('r4: waitIdle ends at once when the turn is stopped', async () => {
  const lock = require('../lib/codex-cli/update-lock');
  assert.equal(lock.begin(), true);
  try {
    const ac = new AbortController();
    const p = lock.waitIdle(60000, ac.signal);
    ac.abort();
    assert.equal(await p, false);
    const ac2 = new AbortController(); ac2.abort();
    assert.equal(await lock.waitIdle(60000, ac2.signal), false, 'already stopped');
  } finally { lock.end(); }
  assert.equal(await lock.waitIdle(10), true);
});

test('server.js /api/settings: componentUpdates is cleaned to one of auto, notify, off', () => {
  // the route's cleaners moved from server.js into lib/settings-apply cleanSettingsPatch (the lead's settings tool uses them too)
  const applySrc = read('lib/settings-apply.js');
  assert.ok(applySrc.includes("if (patch.componentUpdates !== undefined) patch.componentUpdates = { codex: ['auto', 'notify', 'off'].includes(patch.componentUpdates && patch.componentUpdates.codex) ? patch.componentUpdates.codex : 'auto' };"));
  assert.ok(applySrc.indexOf('patch.componentUpdates !== undefined') > applySrc.indexOf('patch.modelOffers !== undefined'));
  assert.ok(server.includes("require('./lib/settings-apply').cleanSettingsPatch(patch,"), 'the route calls it');
});

test('app.js: the section is in the Status group before st-updates-section, admin-gated', () => {
  const ids = require('../lib/ui-settings-groups.js').GROUPS.find((g) => g.id === 'upkeep').sections;   // Upkeep holds it now
  assert.ok(ids.indexOf('st-components-section') > 0 && ids.indexOf('st-components-section') === ids.indexOf('st-updates-section') - 1);
  assert.equal(ids[ids.indexOf('st-updates-section') + 1], 'st-emergency-section');
  const at = app.indexOf('id="st-components-section"');
  assert.ok(at > 0);
  assert.match(app.slice(app.lastIndexOf('\n', at - 200) - 200, at), /if \(isHubAdmin\(\)\) \{\s*html \+= `<div class="st-section" $/);
  assert.match(app.slice(at, at + 200), /Software your Maestro relies on/);
  assert.ok(at < app.indexOf('id="st-updates-section"'));
});

test('app.js: server text goes through escapeHtml; the buttons post to the right routes', () => {
  const a = app.indexOf('function componentUpdateLine(lu, day)');
  assert.ok(a > 0 && a < app.indexOf('function paintComponents(data)'));
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

// The update line under a component row, run for real (its source from app.js in a vm, with the page's escaping).
function updateLine() {
  const vm = require('vm');
  const start = app.indexOf('function componentUpdateLine(lu, day)');
  const src = app.slice(start, app.indexOf('// Software your Maestro relies on (Settings', start));
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const ctx = { escapeHtml: esc };
  vm.runInNewContext(`${src}; this.fn = componentUpdateLine;`, ctx);
  return ctx.fn;
}
const DAY = (t) => (t ? 'D' + t : '');

test('Settings → Status: a failed update shows the reason the server gave, as one plain sentence', () => {
  const f = updateLine();
  const rolled = { at: 5, ok: false, from: '0.1.0', to: '0.170.0', rolledBack: true, error: 'The new Codex 0.170.0 failed its check, so 0.1.0 was put back.' };
  assert.equal(f(rolled, DAY), '<div>Last update (D5): The new Codex 0.170.0 failed its check, so 0.1.0 was put back.</div>');
  const stuck = { at: 6, ok: false, from: '0.1.0', to: '0.170.0', rolledBack: false, error: 'The new Codex 0.170.0 works, but the update could not be finished (the folder /x could not be changed), so the next start of your Maestro puts 0.1.0 back.' };
  assert.match(f(stuck, DAY), /could not be finished \(the folder \/x could not be changed\)/);
  const refused = { at: 7, ok: false, from: '0.1.0', to: null, error: "Couldn't keep a copy of the current Codex, so nothing changed." };
  assert.equal(f(refused, DAY), "<div>Last update (D7): Couldn't keep a copy of the current Codex, so nothing changed.</div>");
});

test('Settings → Status: the reason is escaped, cut to its first line and 300 characters, and ends as a sentence', () => {
  const f = updateLine();
  assert.equal(f({ at: 1, ok: false, to: '9', error: 'npm said <b>no</b>\nstack line 2' }, DAY), '<div>Last update (D1): npm said &lt;b&gt;no&lt;/b&gt;.</div>');
  const long = f({ at: 1, ok: false, to: '9', error: 'x'.repeat(500) }, DAY);
  assert.equal(long, `<div>Last update (D1): ${'x'.repeat(300)}.</div>`);
  assert.equal(f({ ok: false, to: '9', error: 'Failed!' }, DAY), '<div>Last update: Failed!</div>');
});

test('Settings → Status: without a reason the old lines stay; a good update shows its date; nothing for none', () => {
  const f = updateLine();
  assert.equal(f({ at: 2, ok: true, from: '0.1.0', to: '0.170.0' }, DAY), '<div>Updated from 0.1.0 to 0.170.0 on D2</div>');
  assert.equal(f({ at: 2, ok: false, from: '0.1.0', to: '0.170.0', rolledBack: true, error: null }, DAY), '<div>Update to 0.170.0 failed; 0.1.0 was put back.</div>');
  assert.equal(f({ at: 2, ok: false, from: '0.1.0', to: null, error: '  ' }, DAY), '<div>Not updated: the update did not run.</div>');
  assert.equal(f(null, DAY), '');
  assert.equal(f(undefined, DAY), '');
});

test('Settings → Status: the hint speaks of your Maestro, not the hub', () => {
  const at = app.indexOf('id="st-components-section"');
  const hint = app.slice(at, app.indexOf('id="st-cw-list"', at));
  assert.match(hint, /Your Maestro looks now and then/);
  assert.doesNotMatch(hint, /\bhub\b/i);
});
