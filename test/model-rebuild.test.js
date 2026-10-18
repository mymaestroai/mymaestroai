'use strict';
// The "only a few Claude models after an update" bug (a tester, the owner 2026-10-12): three guards, checked at the
// source level because discovery itself talks to every provider.
//   1. runDiscovery shares the run in progress with a second caller instead of handing back the old cache;
//   2. listModels never memoises a list built from the quick live probes alone;
//   3. the updater keeps the model list (marked stale) instead of deleting it; /api/models reports the state.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('runDiscovery: a caller during a run joins it (same promise), and isDiscovering is exported', () => {
  const src = read('lib/model-discovery.js');
  assert.match(src, /if \(_inflight\) \{[\s\S]*?return _inflight;/);
  assert.match(src, /_inflight = _runDiscovery\(\)\.finally\(\(\) => \{ _inflight = null; \}\)/);
  assert.ok(!/Already running, skipping[\s\S]*?return loadCache\(\)/.test(src), 'the old "skip and return the stale cache" path is gone');
  assert.match(src, /function isDiscovering\(\) \{ return !!_inflight; \}/);
  assert.match(src, /module\.exports = \{[\s\S]*isDiscovering,/);
});

test('listModels: a probed-only list (no discovery cache yet) is returned but never cached for the TTL', () => {
  const src = read('lib/gateway-client.js');
  const tail = src.slice(src.indexOf('async function listModels'), src.indexOf('function supportsImages'));
  assert.match(tail, /if \(!haveDiscovery\) \{[\s\S]*?return sorted;[\s\S]*?\}\s*\n\s*_modelsCache = sorted;/);
});

test('/api/models reports discovering, stale and discoveredAt; the editor shows a rebuilding note and refetches', () => {
  const server = read('server.js');
  assert.match(server, /discovering: md\.isDiscovering\(\)/);
  assert.match(server, /stale: !!dcache\.stale/);
  const page = read('agent-settings.html');
  assert.match(page, /function watchModelRebuild\(modelsData\)/);
  assert.match(page, /Model list is rebuilding/);
  assert.match(page, /watchModelRebuild\(modelsData\);/);
});

test('the updater no longer deletes the model cache', () => {
  const src = read('lib/git-sync.js');
  assert.ok(!/unlinkSync\([^)]*discovered-models/.test(src));
  assert.match(src, /cache\.stale = true/);
});
