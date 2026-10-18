#!/usr/bin/env node
'use strict';

/**
 * diagnose-models.js — Why aren't my Claude models showing up?
 *
 * Walks the model-discovery chain step by step and reports where it breaks.
 * Prints no secrets: tokens are reported only as present/absent plus length.
 *
 *   node scripts/diagnose-models.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const no = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`    ${m}`);
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

(async () => {
  console.log('\n═══ My Maestro AI — Model Discovery Diagnostic ═══');

  // ── 1. Environment ────────────────────────────────────────────────
  head('1. Environment');
  info(`platform : ${process.platform}`);
  info(`node     : ${process.version}`);
  const major = parseInt(process.version.slice(1), 10);
  if (major < 18) no(`Node ${process.version} is too old — the SDK needs 18+. Run: brew install node`);
  else ok(`Node version supported`);

  // ── 2. Claude CLI ─────────────────────────────────────────────────
  head('2. Claude CLI');
  let cliPath = null;
  try {
    cliPath = execSync('which claude', { encoding: 'utf8' }).trim();
    ok(`found at ${cliPath}`);
  } catch {
    info('not on PATH for this process — not necessarily a problem, the SDK');
    info('ships its own binary. Only matters if step 5 below also fails.');
  }

  // ── 3. Credentials ────────────────────────────────────────────────
  head('3. OAuth credentials');
  let token = null;
  const credFile = path.join(process.env.HOME || '', '.claude', '.credentials.json');
  if (fs.existsSync(credFile)) {
    try {
      token = JSON.parse(fs.readFileSync(credFile, 'utf8'))?.claudeAiOauth?.accessToken;
      if (token) ok(`token from ${credFile} (${token.length} chars)`);
      else no(`${credFile} exists but has no claudeAiOauth.accessToken`);
    } catch (e) {
      no(`${credFile} unreadable: ${e.message}`);
    }
  } else {
    info(`no file at ${credFile}`);
  }

  if (!token && process.platform === 'darwin') {
    info('trying macOS Keychain…');
    try {
      const out = execSync('security find-generic-password -s "Claude Code-credentials" -w',
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      token = JSON.parse(out)?.claudeAiOauth?.accessToken;
      if (token) ok(`token from Keychain (${token.length} chars)`);
      else no('Keychain entry found but contains no accessToken');
    } catch (e) {
      no(`Keychain read failed: ${(e.stderr || e.message || '').toString().trim().slice(0, 160)}`);
      info('If this says "User interaction is not allowed", macOS is blocking');
      info('non-interactive access. Unlock with: security unlock-keychain');
      info('Or run `claude` once in this terminal to refresh credentials.');
    }
  }
  if (!token) no('NO TOKEN FOUND — /v1/models cannot be queried');

  // What the app itself concludes — this drives the available/unavailable
  // badge in the agent editor.
  try {
    const auth = require(path.join(__dirname, '..', 'lib', 'claude-auth'));
    info(`credential source : ${auth.credentialSource()}`);
    if (auth.hasSdkCredentials()) ok('hasSdkCredentials() = true — models will show as available');
    else no('hasSdkCredentials() = false — every Claude model will show UNAVAILABLE');
  } catch (e) {
    no(`claude-auth check failed: ${e.message}`);
  }

  // ── 4. The authoritative endpoint ─────────────────────────────────
  head('4. GET /v1/models (authoritative source)');
  if (!token) {
    no('skipped — no token');
  } else {
    try {
      const r = await fetch('https://api.anthropic.com/v1/models?limit=1000', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) {
        const ids = (await r.json()).data.map(m => m.id);
        ok(`HTTP 200 — ${ids.length} models`);
        ids.forEach(i => info(`• ${i}`));
      } else {
        no(`HTTP ${r.status}`);
        info((await r.text()).slice(0, 300));
        if (r.status === 401) info('Token rejected or expired — run `claude` and re-authenticate.');
      }
    } catch (e) {
      no(`request failed: ${e.message}`);
      info('Network blocked or offline?');
    }
  }

  // ── 5. SDK aliases ────────────────────────────────────────────────
  head('5. SDK supportedModels()');
  let q = null;
  try {
    const { loadSdk, resolveSdk } = require('../lib/sdk-loader');
    const r = resolveSdk();
    info(`resolved SDK ${r.version} from ${r.source} (${r.dir})`);
    for (const c of r.candidates) if (c.dir !== r.dir) info(`  also installed: ${c.source} ${c.version}`);
    const sdk = await loadSdk();
    q = sdk.query({
      prompt: (async function* () { await new Promise(r => setTimeout(r, 30000)); })(),
      options: { maxTurns: 1, permissionMode: 'acceptEdits', tools: [] },
    });
    const models = await q.supportedModels();
    ok(`${models.length} aliases`);
    models.forEach(m => info(`• ${m.value} — ${m.description || ''}`));
  } catch (e) {
    no(`failed: ${(e.message || '').slice(0, 200)}`);
    info('This usually means the SDK cannot launch the claude binary,');
    info('or authentication is incomplete. Run `claude` manually first.');
  } finally {
    try { q?.close(); } catch {}
  }

  // ── 6. End result ─────────────────────────────────────────────────
  head('6. What the agent editor will show');
  try {
    const { runDiscovery } = require(path.join(__dirname, '..', 'lib', 'model-discovery'));
    const res = await runDiscovery();
    const sdk = res['claude-sdk'] || [];
    if (sdk.length > 0) {
      ok(`${sdk.length} claude-sdk models`);
      sdk.forEach(m => info(`• claude-sdk/${m}`));
    } else {
      no('ZERO claude-sdk models — this is the bug you are seeing');
    }
    for (const p of ['anthropic', 'openai', 'google', 'perplexity', 'lmstudio', 'ollama']) {
      if ((res[p] || []).length) info(`${p}: ${res[p].length}`);
    }
  } catch (e) {
    no(`discovery threw: ${e.message}`);
  }

  console.log('\n═══ end ═══\n');
})();
