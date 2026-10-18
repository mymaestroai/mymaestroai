'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

test('the wallet panel is a docked side panel that leaves the chat usable, not a full-screen modal', () => {
  const start = app.indexOf('async function openWalletPanel('), end = app.indexOf('async function walletAct(');
  assert.ok(start > 0 && end > start);
  const panel = app.slice(start, end);
  const calls = panel.match(/gsModal\([^;]*?\)(?=;| \})/gs) || [];
  assert.ok(calls.length >= 3, 'every render path goes through gsModal');
  for (const c of calls) assert.match(c, /, dock\)$/, `wallet render must dock: ${c.slice(-60)}`);
  assert.match(panel, /dock: true, title: '👛 Trading wallets'/);
  assert.match(panel, /X-Executor-Token/, 'the Hyperliquid box tells the owner the agent can finish setup by API with the executor token');
});

test('when locked, the Unlock box is the first box and an empty passphrase is caught before and at the server', () => {
  const start = app.indexOf('async function openWalletPanel('), end = app.indexOf('async function walletAct(');
  const panel = app.slice(start, end);
  assert.ok(panel.indexOf('Unlock the keystore') < panel.indexOf('Wallets on Base'), 'unlock box renders before the wallet list');
  assert.ok(panel.indexOf('Unlock the keystore') < panel.indexOf('Executor (scripts'), 'and before the Executor box with its own passphrase field');
  assert.match(panel, /id="w-pass"[^>]*autocomplete="new-password"/, 'no browser autofill into the unlock field');
  assert.match(panel, /event\.key==='Enter'[^"]*walletAct\('unlock'\)/, 'Enter submits');
  assert.equal((panel.match(/id="w-pass"/g) || []).length, 2, 'one unlock field when locked, one when creating the keystore');
  const act = app.slice(end, app.indexOf('async function openGitSync'));
  assert.match(act, /if \(!p\) \{[\s\S]{0,200}?"Unlock the keystore" box at the top/);
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.match(server, /No passphrase was sent\. Type it in the Unlock box/, 'an empty passphrase is not reported as a wrong one');
  assert.match(server, /svc\.audit\('owner', 'UNLOCK', \{\}, \{ ok: false, error: e\.message \}\)/, 'failed unlocks are audited');
});

test('docked mode: no dimmed backdrop, clicks pass through to the chat, sticky Close, boxes not clipped', () => {
  assert.match(html, /\.gs-overlay\.gs-dock \{[^}]*pointer-events: none/);
  assert.match(html, /\.gs-overlay\.gs-dock \.gs-modal \{[^}]*pointer-events: auto/);
  assert.match(html, /\.gs-overlay\.gs-dock \.gs-box \{ max-height: none; \}/, 'Executor and Hyperliquid boxes show in full');
  assert.match(html, /\.gs-dock-head \{[^}]*position: sticky/);
  assert.match(app, /class="gs-dock-close"[^>]*>✕ Close</);
  assert.match(app, /gs-dock-grip/, 'resizable by dragging the left edge');
  assert.match(app, /e\.key === 'Escape'\) overlay\.remove\(\)/);
  const plain = app.slice(app.indexOf('function gsModal('), app.indexOf('const gsClose'));
  assert.match(plain, /if \(!dock\) \{[\s\S]*?e\.target === overlay\) overlay\.remove\(\)/, 'plain modals still close on backdrop click');
});

test('recovery: reveal, import and backup are owner panel actions and routes, never tools', () => {
  const start = app.indexOf('async function openWalletPanel('), end = app.indexOf('async function openGitSync');
  const panel = app.slice(start, end);
  assert.match(panel, /walletAct\('reveal', '\$\{esc\(w\.name\)\}'\)/, 'Reveal key per wallet');
  assert.match(panel, /id="w-reveal-pass"[^>]*autocomplete="new-password"/, 'reveal takes the passphrase from its own field');
  assert.match(panel, /id="w-import-secret"/); assert.match(panel, /walletApi\('import', \{ name: v\('w-import-name'\), secret, index: v\('w-import-index'\), tier, fundingCapUsd: tier === 'open' \? v\('w-cap'\) : undefined \}\)/);
  assert.match(panel, /if \(el\) el\.value = '';\s*if \(!secret\.trim\(\)\)/, 'the pasted secret is cleared from the field at once');
  assert.match(panel, /walletApi\('backup', \{\}\)/); assert.match(panel, /wallet-recover\.js/, 'the panel tells the owner about the offline script');
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  for (const r of ['/api/wallet/import', '/api/wallet/reveal', '/api/wallet/backup']) assert.ok(server.includes(`pathname === '${r}'`), r);
  assert.match(server, /svc\.audit\('owner', 'KEY_REVEALED'/); assert.match(server, /svc\.audit\('owner', 'WALLET_IMPORTED'/);
  const tools = fs.readFileSync(path.join(__dirname, '../lib/wallet/tools.js'), 'utf8');
  assert.ok(!/reveal|importWallet|mnemonic/i.test(tools), 'no agent tool can reveal or import keys');
});
