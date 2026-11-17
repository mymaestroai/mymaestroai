'use strict';
// claudeClientEnv and the Claude client start sites. Fake values only; hub-secrets is a require.cache stand-in.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const B = require('../lib/billing');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('claudeClientEnv: no API key, plus the .env-held sign-in token from the store (which wins over a launch-time one)', () => {
  const hsPath = require.resolve('../lib/hub-secrets');
  const saved = require.cache[hsPath];
  const store = { CLAUDE_CODE_OAUTH_TOKEN: 'oat-test', OTHER_TOKEN: 'ghp-test-1' };
  require.cache[hsPath] = { id: hsPath, filename: hsPath, loaded: true, exports: { has: (n) => n in store, get: (n) => store[n] } };
  try {
    assert.deepStrictEqual(B.claudeClientEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-test-123' }), { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'oat-test' });
    assert.strictEqual(B.claudeClientEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'launch-old' }).CLAUDE_CODE_OAUTH_TOKEN, 'oat-test', 'the .env value wins, as everywhere in the hub');
    delete store.CLAUDE_CODE_OAUTH_TOKEN;
    assert.strictEqual('CLAUDE_CODE_OAUTH_TOKEN' in B.claudeClientEnv({ PATH: '/bin' }), false);
    assert.strictEqual(B.claudeClientEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'launch-old' }).CLAUDE_CODE_OAUTH_TOKEN, 'launch-old', 'a launch-time token passes when .env has none');
  } finally { if (saved) require.cache[hsPath] = saved; else delete require.cache[hsPath]; }
});

test('every Claude client start passes env from claudeClientEnv; the boxed branch carries no sign-in token', () => {
  for (const f of ['lib/dream.js', 'lib/model-discovery.js', 'lib/plan-usage.js']) {
    const src = read(f);
    const n = (src.match(/sdk(?:Module)?\.query\(/g) || []).length;
    assert.ok(n > 0, f);
    assert.strictEqual((src.match(/env: require\('\.\/billing'\)\.claudeClientEnv\(\)/g) || []).length, n, `${f}: ${n} query sites`);
  }
  assert.match(read('lib/welcome.js'), /require\('\.\/billing'\)\.claudeClientEnv\)\(childEnv\)/);
  const chat = read('lib/sdk-chat.js');
  const i = chat.indexOf('? { PATH: process.env.PATH, HOME: process.env.HOME,');
  assert.ok(i > 0);
  assert.ok(!chat.slice(i, chat.indexOf('\n', i)).includes('CLAUDE_CODE_OAUTH_TOKEN'), 'boxed branch');
});
