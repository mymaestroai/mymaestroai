'use strict';

const crypto = require('crypto');

function stamp(provider) {
  return provider === 'claude-sdk' ? require('./plan-usage').claudeCredentialStamp()
    : require('./codex-usage').defaultCredentialStamp();
}

// Only local status commands. Store a digest of stable account and plan metadata,
// so rotating access tokens do not invalidate the catalog.
async function account(provider) {
  try {
    let fields;
    if (provider === 'claude-sdk') {
      const cli = require('./claude-signin');
      const env = cli.clientEnv(), client = cli.findClient({ env });
      if (!client) return null;
      const s = await cli.authStatus({ bin: client.bin, env, accountMetadata: true, timeoutMs: 5000 });
      if (!s.loggedIn || !['claude.ai', 'oauth_token'].includes(s.method) || !s.account?.some(Boolean)) return null;
      fields = s.account;
    } else {
      const cli = require('./codex-cli');
      const env = cli.withNode(require('./codex-usage').codexEnv());
      const bin = cli.resolveBinary(env);
      if (!bin) return null;
      const { AppServerClient } = require('./codex-cli/app-server');
      const client = new AppServerClient({ bin, env, agentName: 'offer-account' });
      try {
        await client.initialize();
        const { account } = await client.request('account/read', { refreshToken: false }, { timeoutMs: 5000 });
        if (account?.type !== 'chatgpt' || !account.email) return null;
        fields = [account.email, account.planType || null];
      } finally { client.close(); }
    }
    return crypto.createHash('sha256').update(JSON.stringify([provider, ...fields])).digest('hex');
  } catch { return null; }
}

module.exports = { account, stamp };
