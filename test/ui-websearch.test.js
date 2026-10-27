'use strict';
// "Web search and fetch" box on the desktop Settings page (app.js openSettings + the web* / searxng* functions) and
// the admin routes behind it. Source-string tests in the ui-*.test.js pattern: the page is not executed here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js');
const server = read('server.js');

test('Settings has a Web search and fetch section with the backend order, keys, SearXNG, fetch guards and try-it rows', () => {
  assert.match(app, /<div class="st-section" id="st-ws-section"><h4>Web search and fetch<\/h4>/);
  const at = app.indexOf('const keyRow = (id, label, note) =>');
  assert.ok(at > 0, 'the key-row helper exists');
  const end = app.indexOf('setTimeout(loadWebSearchStatus, 0);', at);
  assert.ok(end > at, 'the box loads its status after the modal opens');
  const box = app.slice(at, end + 40);
  assert.match(box, /id="st-ws-order"/);
  assert.match(box, /type="password" id="st-ws-key-\$\{id\}"/, 'key fields are password inputs that never echo the saved key');
  for (const k of ['brave', 'serper', 'tavily']) assert.match(box, new RegExp(`\\$\\{keyRow\\('${k}', `), k);
  assert.match(box, /uses the Perplexity provider key above/);
  assert.match(box, /id="st-ws-searxng"[^>]*placeholder="http:\/\/127\.0\.0\.1:8888"/);
  assert.match(box, /onclick="searxngStart\(\)">Run SearXNG here \(Docker\)<\/button>/);
  assert.match(box, /selWs\('st-wf-private', \[\['admin'/); assert.match(box, /selWs\('st-wf-render', \[\['auto'/); assert.match(box, /id="st-wf-jina"/);
  assert.match(box, /onclick="saveWebSearch\(\)">Save web settings<\/button>/);
  assert.match(box, /id="st-ws-try"/); assert.match(box, /id="st-wf-try"/);
  assert.match(box, /setTimeout\(loadWebSearchStatus, 0\);/);
});

test('the box functions exist and talk to the websearch routes; key fields are cleared after saving', () => {
  for (const fn of ['loadWebSearchStatus', 'saveWebSearch', 'tryWebSearch', 'tryWebFetch', 'searxngStart', 'searxngStop']) assert.match(app, new RegExp(`async function ${fn}\\(`), fn);
  assert.match(app, /fetch\('\/api\/websearch\/status', \{ credentials: 'include' \}\)/);
  assert.match(app, /fetch\('\/api\/websearch\/config', \{ method: 'POST'/);
  assert.match(app, /fetch\('\/api\/websearch\/test', \{ method: 'POST'/);
  assert.match(app, /fetch\('\/api\/websearch\/fetch-test', \{ method: 'POST'/);
  assert.match(app, /fetch\('\/api\/websearch\/searxng\/start', \{ method: 'POST'/);
  assert.match(app, /fetch\('\/api\/websearch\/searxng\/stop', \{ method: 'POST'/);
  assert.match(app, /if \(inp && inp\.value === v\) \{ inp\.placeholder = 'set'; inp\.value = ''; dialogGuard\.markLoaded\(inp\); \}/);   // only a key saved as typed
});

test('server routes: status, config (merge, keys unchanged when blank), test, fetch-test, searxng start as a job and stop', () => {
  assert.match(server, /if \(pathname\.startsWith\('\/api\/websearch'\)\) \{/);
  for (const r of ['/api/websearch/status', '/api/websearch/config', '/api/websearch/test', '/api/websearch/fetch-test', '/api/websearch/searxng/start', '/api/websearch/searxng/stop']) assert.ok(server.includes(`pathname === '${r}'`), r);
  assert.match(server, /if \(v === null\) delete next\.keys\[k\]; else if \(typeof v === 'string' && v\.trim\(\)\) next\.keys\[k\] = v\.trim\(\);/);
  assert.match(server, /name: 'start SearXNG search container', command: ws\.searxng\.startCommand\(port\)/);
  assert.match(server, /wf\.clearCache\(\);/);
});
