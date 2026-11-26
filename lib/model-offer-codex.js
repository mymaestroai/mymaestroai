'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function digest(value) {
  const sorted = (_, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v;
  return crypto.createHash('sha256').update(JSON.stringify(value, sorted)).digest('hex');
}

const routeEnv = /^(CODEX_|OPENAI_|CHATGPT_|AZURE_|XDG_|NODE_|LD_|DYLD_|HOME$|PATH$)|PROXY$|CERT/i;

// Recheck synchronously inside the registry write guard. Include absent project layers
// so adding a config after config/read also invalidates the approval.
function configFiles(home, cwd) {
  const files = new Set(['/etc/codex/config.toml', '/etc/codex/managed_config.toml', '/etc/codex/requirements.toml',
    path.join(home, 'config.toml'), path.join(home, 'managed_config.toml')]);
  let dir = fs.realpathSync(cwd);
  for (;;) {
    files.add(path.join(dir, '.codex', 'config.toml'));
    if (dir === path.dirname(dir)) return files;
    dir = path.dirname(dir);
  }
}

function stamp({ bin, env }, cwd = process.cwd()) {
  try {
    if (!bin || !env.HOME || !path.isAbsolute(cwd)) return null;
    const home = env.CODEX_HOME || path.join(env.HOME, '.codex');
    if (!path.isAbsolute(home)) return null;
    const credential = require('./codex-usage').defaultCredentialStamp({ env });
    if (!credential) return null;
    const files = configFiles(home, cwd);
    files.add(bin);
    const versions = Array.from(files, file => {
      const s = fs.statSync(file, { bigint: true, throwIfNoEntry: false });
      return [file, s ? [s.dev, s.ino, s.size, s.ctimeNs].map(String) : null];
    });
    const routing = Object.fromEntries(Object.entries(env).filter(([key]) => routeEnv.test(key)));
    return digest([bin, routing, home, credential, versions]);
  } catch { return null; }
}

async function configId(client, cwd, env) {
  const result = await client.request('config/read', { cwd, includeLayers: true }, { timeoutMs: 5000 });
  if (!Array.isArray(result?.layers)) return null;
  const watched = configFiles(env.CODEX_HOME || path.join(env.HOME, '.codex'), cwd);
  for (const { name } of result.layers) {
    if (name?.type === 'sessionFlags') continue;
    const file = name?.type === 'project' && typeof name.dotCodexFolder === 'string'
      ? path.join(name.dotCodexFolder, 'config.toml') : name?.file;
    if (!watched.has(file)) return null;
  }
  const cfg = result.config;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
  if (cfg.model_provider != null && cfg.model_provider !== 'openai') return null;
  if (cfg.forced_login_method != null && cfg.forced_login_method !== 'chatgpt') return null;
  // A configured catalog, profile, transport, or auth override has no proven
  // relationship to the ChatGPT subscription catalog returned by debug models.
  for (const [key, value] of Object.entries(cfg)) {
    if (value == null || key === 'model_provider') continue;
    if (key === 'cli_auth_credentials_store' && ['auto', 'file'].includes(value)) continue;
    if (key === 'chatgpt_base_url' && ['https://chatgpt.com/backend-api', 'https://chatgpt.com/backend-api/'].includes(value)) continue;
    if (key === 'model_providers') {
      if (Object.keys(value).length) return null;
    } else if (/base_url|endpoint|model_catalog|^profile$|^oss_provider$|credential|bearer_token|api_key|auth_proxy|forced_chatgpt_workspace_id/i.test(key)) return null;
  }
  return digest(cfg);
}

function matchesTurnEnv(agent, env) {
  const actual = require('./codex-cli').agentRuntimeEnv(agent, require('./child-env').leadCheck());
  const keys = new Set([...Object.keys(actual), ...Object.keys(env)]);
  for (const key of keys) {
    if (routeEnv.test(key) &&
        key !== 'CODEX_CLI_PATH' && actual[key] !== env[key]) return false;
  }
  return true;
}

async function agentProof(agent, ctx) {
  const cwd = await require('./agents').getAgentWorkspace(agent.name);
  const current = () => matchesTurnEnv(agent, ctx.env) && stamp(ctx, cwd);
  const before = current();
  if (!before) return null;
  const { AppServerClient } = require('./codex-cli/app-server');
  const client = new AppServerClient({ ...ctx, cwd, agentName: 'offer-route' });
  try {
    await client.initialize();
    const config = await configId(client, cwd, ctx.env);
    if (!config || current() !== before) return null;
    return { id: digest([before, config]), valid: record => matchesTurnEnv(record, ctx.env) && stamp(ctx, cwd) === before };
  } finally { client.close(); }
}

module.exports = { stamp, configId, agentProof };
