'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { walletLockedNotice, LOCKED_NOTICE_DELAY_MS } = require('../lib/wallet/locked-notice');

function make(over = {}) {
  const calls = [];
  const warns = [];
  const args = {
    getSetting: () => undefined,
    keystore: { exists: () => true, isUnlocked: () => false, list: () => [{ name: 'main' }] },
    notifyEach: async (...a) => { calls.push(a); return { sent: 1 }; },
    log: { warn: (m) => warns.push(m) },
    ...over,
  };
  return { args, calls, warns };
}

test('delay is one minute', () => {
  assert.strictEqual(LOCKED_NOTICE_DELAY_MS, 60000);
});

test('each reason for staying quiet', async () => {
  const cases = [
    ['off', { getSetting: (k) => (k === 'walletLockedNotice' ? false : undefined) }],
    ['no_keystore', { keystore: { exists: () => false, isUnlocked: () => false, list: () => [{}] } }],
    ['unlocked', { keystore: { exists: () => true, isUnlocked: () => true, list: () => [{}] } }],
    ['no_wallets', { keystore: { exists: () => true, isUnlocked: () => false, list: () => [] } }],
  ];
  for (const [reason, over] of cases) {
    const { args, calls } = make(over);
    assert.deepStrictEqual(await walletLockedNotice(args), { sent: false, reason });
    assert.strictEqual(calls.length, 0, reason);
  }
});

test('sends once with the exact payload and options', async () => {
  const { args, calls } = make();
  const out = await walletLockedNotice(args);
  assert.deepStrictEqual(out, { sent: true, result: { sent: 1 } });
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], [
    {
      title: 'Your wallet is locked',
      body: 'My Maestro restarted. Tap to unlock it with Face ID, fingerprint or the passphrase.',
      url: '/mobile?wallet=unlock',
      tag: 'wallet-locked',
    },
    { adminsOnly: true, urgency: 'high' },
  ]);
});

test('the notice stays on when the setting is true or unset', async () => {
  const { args, calls } = make({ getSetting: () => true });
  assert.strictEqual((await walletLockedNotice(args)).sent, true);
  assert.strictEqual(calls.length, 1);
});

test('an error from notifyEach is caught and logged', async () => {
  const { args, warns } = make({ notifyEach: async () => { throw new Error('push down'); } });
  assert.deepStrictEqual(await walletLockedNotice(args), { sent: false, reason: 'error' });
  assert.deepStrictEqual(warns, ['[wallet] locked notice failed: push down']);
});
