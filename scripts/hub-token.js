#!/usr/bin/env node
'use strict';
/**
 * API tokens from the terminal (the Users page does the same in the browser). Works on data/auth.db directly, so it
 * also works while the hub is stopped, or before a restart has made new code live.
 *
 *   node scripts/hub-token.js create --name trading-bots --scopes chat,interject,status,wallet-executor --agents trader --out workspaces/degen/bots/.hub-token
 *   node scripts/hub-token.js create --name api-client --scopes openai-api --any-host --expires-days 90
 *   node scripts/hub-token.js list
 *   node scripts/hub-token.js revoke <id>
 *
 * The token is printed once, or with --out written to that file (mode 600) and not printed. The program sends it as the
 * header "Authorization: Bearer hub_…". --data-dir <dir> uses another data folder (tests).
 */
const fs = require('fs');
const path = require('path');
const { createAuth, TOKEN_SCOPES } = require(path.join(__dirname, '..', 'lib', 'auth'));

function arg(name, dflt = null) { const i = process.argv.indexOf(`--${name}`); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt; }
const flag = (name) => process.argv.includes(`--${name}`);

const auth = createAuth({ log: () => {}, ...(arg('data-dir') ? { dataDir: path.resolve(arg('data-dir')) } : {}) });
const cmd = process.argv[2];
try {
  if (cmd === 'create') {
    const r = auth.createToken({ name: arg('name'), scopes: arg('scopes', ''), agents: arg('agents'), loopbackOnly: !flag('any-host'), expiresDays: arg('expires-days'), by: 'cli' });
    const t = r.record;
    console.log(`Token "${t.name}" (${t.id}): scopes ${t.scopes.join(', ')}; agents ${t.agents ? t.agents.join(', ') : 'none'}; ${t.loopbackOnly ? 'this machine only' : 'any host'}; expires ${t.expiresAt || 'never'}.`);
    const out = arg('out');
    if (out) { fs.writeFileSync(out, r.token + '\n', { mode: 0o600 }); fs.chmodSync(out, 0o600); console.log(`Written to ${out} (mode 600); it is not shown again.`); }
    else { console.log('Copy it now; it is not shown again:\n'); console.log(r.token); }
  } else if (cmd === 'list') {
    const list = auth.listTokens();
    if (!list.length) console.log('No tokens.');
    for (const t of list) console.log(`${t.id}  ${t.name.padEnd(20)}  ${t.scopes.join(',').padEnd(40)}  agents=${t.agents ? t.agents.join(',') : '-'}  ${t.loopbackOnly ? 'local' : 'any-host'}  last used ${t.lastUsed || 'never'}${t.revokedAt ? '  REVOKED' : ''}${t.expiresAt ? `  expires ${t.expiresAt}` : ''}`);
  } else if (cmd === 'revoke') {
    const t = auth.revokeToken(process.argv[3], { by: 'cli' });
    console.log(`Revoked ${t.id} "${t.name}".`);
  } else {
    console.log('Usage: hub-token.js create --name <n> --scopes a,b[,c] [--agents x,y] [--any-host] [--expires-days N] [--out <file>] | list | revoke <id>   [--data-dir <dir>]');
    console.log('Scopes:'); for (const [k, v] of Object.entries(TOKEN_SCOPES)) console.log(`  ${k.padEnd(16)} ${v}`);
    process.exit(cmd ? 1 : 0);
  }
} catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
