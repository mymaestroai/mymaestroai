'use strict';

const crypto = require('crypto');

function digest(provider, ...fields) {
  return crypto.createHash('sha256').update(JSON.stringify([provider, ...fields])).digest('hex');
}

function source(provider, effective) {
  const local = ['lmstudio', 'ollama', 'omlx', 'ninfer', 'local'].includes(provider);
  if (!local && !['anthropic', 'openai', 'google', 'perplexity', 'openrouter'].includes(provider)) return null;
  const settings = require('./settings');
  // Remote discovery probes the vendor's standard catalog. A custom gateway may serve different models.
  if (!local && settings.getProviderUrl(provider) !== settings.PROVIDER_DEFAULTS?.[provider]?.url) return null;
  if (arguments.length === 1) {
    effective = local ? settings.getProviderUrl(provider) : settings.getProviderKey(provider);
  }
  return effective ? digest(provider, effective) : null;
}

function context(provider) {
  if (provider === 'claude-sdk') {
    const cli = require('./claude-signin');
    const env = cli.clientEnv();
    return { bin: cli.findClient({ env })?.bin || null, env };
  }
  const cli = require('./codex-cli');
  const base = require('./codex-usage').codexEnv();
  const env = cli.withNode?.(base) || base;
  return { bin: cli.resolveBinary?.(env) || null, env };
}

function stamp(provider, client) {
  if (!['claude-sdk', 'codex-cli'].includes(provider)) return source(provider);
  const { bin, env } = client || context(provider);
  const claude = provider === 'claude-sdk';
  let stat = claude ? require('./plan-usage').claudeCredentialStamp({ env, home: env.HOME })
    : require('./codex-usage').defaultCredentialStamp({ env });
  if (!stat && claude && process.platform === 'darwin') {
    const token = require('./claude-auth').getOauthToken(env);
    if (token) stat = digest(provider, token);
  }
  if (!bin || (!stat && !(claude && env.CLAUDE_CODE_OAUTH_TOKEN))) return null;
  return digest(provider, bin, env.HOME, claude ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME,
    claude && env.CLAUDE_CODE_OAUTH_TOKEN, stat);
}

// Only local status commands. Store a digest of stable account and plan metadata,
// so rotating access tokens do not invalidate the catalog.
async function account(provider, clientContext) {
  try {
    const { bin, env } = clientContext || context(provider);
    if (!bin) return null;
    let fields;
    if (provider === 'claude-sdk') {
      const cli = require('./claude-signin');
      const s = await cli.authStatus({ bin, env, accountMetadata: true, timeoutMs: 5000 });
      if (!s.loggedIn || !['claude.ai', 'oauth_token'].includes(s.method) ||
          !s.account?.[2] || !(s.account[0] || s.account[1])) return null;
      if (env.ANTHROPIC_BASE_URL || env.CLAUDE_CODE_USE_BEDROCK === '1' ||
          env.CLAUDE_CODE_USE_VERTEX === '1' || env.CLAUDE_CODE_USE_FOUNDRY === '1') return null;
      fields = s.account;
    } else {
      if (provider !== 'codex-cli') return null;
      const { AppServerClient } = require('./codex-cli/app-server');
      const client = new AppServerClient({ bin, env, agentName: 'offer-account' });
      try {
        await client.initialize();
        const { account } = await client.request('account/read', { refreshToken: false }, { timeoutMs: 5000 });
        if (account?.type !== 'chatgpt' || !account.email || !account.planType) return null;
        fields = [account.email, account.planType || null];
      } finally { client.close(); }
    }
    return digest(provider, ...fields);
  } catch { return null; }
}

module.exports = { account, stamp, source, context };
