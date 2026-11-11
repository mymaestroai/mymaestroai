'use strict';
// After a restart the wallet keystore is locked. Tell the admins' phones so they can unlock it (Face ID, fingerprint or passphrase).

const LOCKED_NOTICE_DELAY_MS = 60000;

async function walletLockedNotice({ getSetting, keystore, notifyEach, log = console }) {
  try {
    if (getSetting('walletLockedNotice') === false) return { sent: false, reason: 'off' };
    if (!keystore.exists()) return { sent: false, reason: 'no_keystore' };
    if (keystore.isUnlocked()) return { sent: false, reason: 'unlocked' };
    if (keystore.list().length === 0) return { sent: false, reason: 'no_wallets' };
    const result = await notifyEach({
      title: 'Your wallet is locked',
      body: 'My Maestro restarted. Tap to unlock it with Face ID, fingerprint or the passphrase.',
      url: '/mobile?wallet=unlock',
      tag: 'wallet-locked',
    }, { adminsOnly: true, urgency: 'high' });
    return { sent: true, result };
  } catch (e) {
    log.warn(`[wallet] locked notice failed: ${e.message}`);
    return { sent: false, reason: 'error' };
  }
}

module.exports = { walletLockedNotice, LOCKED_NOTICE_DELAY_MS };
