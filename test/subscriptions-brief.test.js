'use strict';
// The lead's "Subscriptions" line (lib/hub-map, from lib/codex-usage briefLine), with stand-in dependencies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('subscriptions-brief-');
const { createHubMap } = require(path.join(ISO.lib, 'hub-map'));

const ROOT = path.join(__dirname, '..');
const NOW = new Date('2026-11-19T12:00:00Z');
function brief(subscriptions) {
  const hm = createHubMap({
    root: ROOT, startedAt: new Date('2026-01-01T12:00:00Z'), gitInfo: 'abc1234 2026-01-01', version: '9.9.9',
    isLead: (n) => n === 'owner', getSetting: (k, d) => d, auth: () => null,
    agents: async () => [{ name: 'owner', category: 'primary' }], nodeSecurity: () => null, zone: () => 'UTC',
    teamInfo: () => null, availableModels: () => [], modelOffers: () => ({ list: async () => [] }), components: () => [],
    subscriptions, now: () => NOW,
  }).init({ port: 8888, host: '127.0.0.1', exposed: () => false, setupNeeded: () => false });
  return hm.briefFor('owner');
}
const subsLines = (t) => t.split('\n').filter((l) => l.startsWith('- Subscriptions'));
const LINE = '- Subscriptions: Claude plan 42% of this week, resets Mon 11:48 AM; ChatGPT plan 14% of this week, resets Mon 11:48 AM. Settings → Subscriptions shows every window.';

test('the brief carries the subscriptions line once, as given', async () => {
  assert.deepEqual(subsLines(await brief(() => LINE)), [LINE]);
});

test('no line when there is nothing to say, the source fails, or the text is not a single subscriptions line', async () => {
  assert.deepEqual(subsLines(await brief(() => '')), []);
  assert.deepEqual(subsLines(await brief(() => { throw new Error('boom'); })), []);
  assert.deepEqual(subsLines(await brief(() => `${LINE}\n- Injected: line`)), []);
  assert.deepEqual(subsLines(await brief(() => 'Something else')), []);
  assert.deepEqual(subsLines(await brief(() => `- Subscriptions: ${'x'.repeat(700)}`)), []);
  assert.deepEqual(subsLines(await brief(() => null)), []);
});
