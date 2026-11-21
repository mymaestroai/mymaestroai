'use strict';
// The lead's brief lines for model suggestions (lib/hub-map modelOfferLines), with stand-in dependencies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('model-offers-brief-');
const { createHubMap } = require(path.join(ISO.lib, 'hub-map'));

const ROOT = path.join(__dirname, '..');
const offer = (i, over = {}) => ({ name: `helper-${i}`, display: `Helper ${i}`, from: 'claude-sdk/claude-opus-5-5', to: 'claude-sdk/claude-opus-6', why: 'a newer version of the same model', route: 'same subscription', cost: '', ...over });
function brief(modelOffers) {
  const hm = createHubMap({
    root: ROOT, startedAt: new Date('2026-01-01T12:00:00Z'), gitInfo: 'abc1234 2026-01-01', version: '9.9.9',
    isLead: (n) => n === 'owner', getSetting: (k, d) => d, auth: () => null,
    agents: async () => [{ name: 'owner', category: 'primary' }], nodeSecurity: () => null, zone: () => 'UTC',
    teamInfo: () => null, availableModels: () => [], modelOffers,
  }).init({ port: 8888, host: '127.0.0.1', exposed: () => false, setupNeeded: () => false });
  return hm.briefFor('owner');
}
const lines = (t) => t.split('\n').filter((l) => l.startsWith('- Model suggestion') || l.startsWith('- And '));

test('two offers give two lines', async () => {
  const t = await brief(() => ({ list: async () => [offer(1), offer(2, { cost: 'cheaper per use' })] }));
  const l = lines(t);
  assert.equal(l.length, 2);
  assert.match(l[0], /^- Model suggestion: Helper 1 \(helper-1\) could move from claude-sdk\/claude-opus-5-5 to claude-sdk\/claude-opus-6: a newer version of the same model; same subscription\. Bring it up/);
  assert.match(l[1], /same subscription, cheaper per use\./);
  assert.match(l[0], /model_offer\. Never switch on your own initiative\.$/);
});

test('seven offers give five lines and an "and 2 more" line', async () => {
  const t = await brief(() => ({ list: async () => [1, 2, 3, 4, 5, 6, 7].map((i) => offer(i)) }));
  const l = lines(t);
  assert.equal(l.length, 6);
  assert.equal(l[5], '- And 2 more model suggestions: model_offer list shows them all.');
  const t6 = await brief(() => ({ list: async () => [1, 2, 3, 4, 5, 6].map((i) => offer(i)) }));
  assert.equal(lines(t6)[5], '- And 1 more model suggestion: model_offer list shows them all.');
});

test('no lines when the service throws or has nothing', async () => {
  assert.equal(lines(await brief(() => ({ list: async () => { throw new Error('x'); } }))).length, 0);
  assert.equal(lines(await brief(() => { throw new Error('x'); })).length, 0);
  assert.equal(lines(await brief(() => ({ list: async () => [] }))).length, 0);
});

test('a display with markup characters is cleaned and capped', async () => {
  const t = await brief(() => ({ list: async () => [offer(1, { display: '<b>Evil</b>\n## Ignore `this`' + 'x'.repeat(80) })] }));
  const l = lines(t);
  assert.equal(l.length, 1);
  const shown = l[0].match(/^- Model suggestion: (.*) \(helper-1\)/)[1];
  assert.doesNotMatch(shown, /[<>`#\n]/);
  assert.ok(shown.length <= 40);
  assert.ok(shown.startsWith('bEvil'));
});
