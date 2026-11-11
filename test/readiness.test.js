'use strict';
// Readiness (lib/readiness): the hub checks its own machine and says what is missing and what to do, in the words
// of the platform it runs on. Fake dependencies describe a Mac with nothing set up, a Mac with members and no Docker,
// and a ready Linux box. Source pins cover the route, the Settings box, the banner, the Users page and the chat notice.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createReadiness } = require('../lib/readiness');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const byId = (r, id) => r.items.find(i => i.id === id);

test('a fresh Mac install updated from before multi-user: no account, no Docker, no poppler; every fix names the Mac way', async () => {
  const r = await createReadiness({
    platform: 'darwin', hasUsers: () => false, setupNeeded: () => false, hasSdkCredentials: () => true,
    agents: async () => [{ name: 'maestro', model: 'claude-sdk/claude-fable-5-1' }],
    sandboxStatus: async () => ({ docker: false, imageReady: false }), fetchStatus: async () => ({ renderer: false, pdftotext: false }),
    searchChain: () => ['duckduckgo'], supervisor: () => 'none', exposed: () => false,
  }).check();
  assert.strictEqual(r.mac, true);
  assert.strictEqual(byId(r, 'accounts').level, 'critical');
  assert.deepStrictEqual(byId(r, 'accounts').action, { label: 'Create the admin account', href: '/welcome' });
  assert.strictEqual(byId(r, 'docker').level, 'info', 'no members yet: Docker is advice, not an alarm');
  assert.match(byId(r, 'docker').fix, /Docker Desktop for Mac/);
  assert.match(byId(r, 'poppler').fix, /brew install poppler/);
  assert.match(byId(r, 'browser-render').fix, /playwright install firefox/);
  assert.strictEqual(byId(r, 'search').level, 'info');
  assert.match(byId(r, 'supervisor').title, /no launchd service/);
  assert.strictEqual(byId(r, 'provider').level, 'ok');
  assert.strictEqual(r.critical, 1);
  assert.strictEqual(byId(r, 'exposed'), undefined);
});

test('a Mac with a member and no Docker: critical, with the consequence spelled out; tools=client warns about the sign-in', async () => {
  const r = await createReadiness({
    platform: 'darwin', hasUsers: () => true, listUsers: () => [{ login: 'owner', role: 'admin', totpEnabled: true }],
    agents: async () => [{ name: 'kid', model: 'claude-sdk/claude-sonnet-5-5', owner: 'm1', sandbox: 'inherit' }],
    isMemberOwned: (a) => a.owner === 'm1', getSetting: (k) => (k === 'toolsDefault' ? 'client' : undefined),
    hasSdkCredentials: () => true,
    sandboxStatus: async () => ({ docker: false, imageReady: false }), fetchStatus: async () => ({ renderer: true, pdftotext: true }), searchChain: () => ['perplexity', 'duckduckgo'], supervisor: () => 'launchd',
  }).check();
  const d = byId(r, 'docker');
  assert.strictEqual(d.level, 'critical');
  assert.match(d.title, /Docker is missing and 1 agent\(s\) need a sandbox/);
  assert.match(d.detail, /get NO shell or file tools/);
  assert.strictEqual(byId(r, 'tools-default').level, 'warn');
  assert.match(byId(r, 'tools-default').fix, /set to hub/);
  assert.strictEqual(byId(r, 'accounts').level, 'ok');
  assert.strictEqual(byId(r, 'poppler').level, 'ok');
  assert.strictEqual(byId(r, 'search').level, 'ok');
  assert.strictEqual(byId(r, 'supervisor').level, 'ok');
});

test('Docker present but no image: a one-click build action; sign-in missing for Claude agents is critical with the login command', async () => {
  const r = await createReadiness({
    platform: 'linux', hasUsers: () => true, listUsers: () => [{ login: 'a', role: 'admin', totpEnabled: false }],
    agents: async () => [{ name: 'w', model: 'claude-sdk/claude-sonnet-5-5', sandbox: 'container' }], hasSdkCredentials: () => false,
    sandboxStatus: async () => ({ docker: true, imageReady: false }), fetchStatus: async () => ({ renderer: true, pdftotext: true }), searchChain: () => ['brave', 'duckduckgo'], supervisor: () => 'systemd',
  }).check();
  assert.strictEqual(byId(r, 'sandbox-image').level, 'critical');
  assert.deepStrictEqual(byId(r, 'sandbox-image').action, { label: 'Build the sandbox image', api: '/api/sandbox/build', method: 'POST' });
  assert.strictEqual(byId(r, 'claude-signin').level, 'critical');
  assert.match(byId(r, 'claude-signin').fix, /claude login/);
  assert.strictEqual(byId(r, 'totp').level, 'warn');
  assert.match(byId(r, 'supervisor').title, /Supervised by systemd/);
  assert.strictEqual(r.critical, 2);
});

test('network-exposed with no accounts is its own critical item; a failed last restart turns the supervisor line into a warning', async () => {
  const r = await createReadiness({
    platform: 'linux', hasUsers: () => false, exposed: () => true, setupNeeded: () => true,
    sandboxStatus: async () => ({ docker: true, imageReady: true, containers: [] }), fetchStatus: async () => ({ renderer: true, pdftotext: true }), searchChain: () => ['searxng', 'duckduckgo'],
    supervisor: () => 'none', restartTail: () => ({ restart: { tail: '[relaunch] 2026-10-13 20:54:25 ❌ the new server did not answer /api/health within 90 s; see x' } }),
  }).check();
  assert.strictEqual(byId(r, 'exposed').level, 'critical');
  assert.strictEqual(byId(r, 'provider').level, 'critical');
  assert.strictEqual(byId(r, 'sandbox').level, 'ok');
  assert.strictEqual(byId(r, 'supervisor').level, 'warn');
  assert.match(byId(r, 'supervisor').detail, /last restart: ❌ the new server did not answer/);
  assert.strictEqual(r.critical, 3);
});

test('wiring: admin route, Settings checklist, admin banner, Users page note, chat notice with the platform fix', () => {
  const server = read('server.js');
  assert.match(server, /pathname === '\/api\/readiness' && req\.method === 'GET'/);
  assert.match(server, /getReadiness\(\{ exposed: \(\) => !!BIND\.exposed, setupNeeded: \(\) => isSetupNeeded\(\) \}\)\.check\(\)/);
  const app = read('app.js');
  assert.match(app, /<div class="st-section" id="st-ready-section"><h4>Setup checklist<\/h4>/);
  assert.match(app, /setTimeout\(loadReadiness, 0\);/);
  for (const fn of ['loadReadiness', 'readinessAction', 'paintReadinessBanner']) assert.match(app, new RegExp(`async function ${fn}\\(`), fn);
  assert.match(app, /paintNoAccountsNotice\(\);\s*\n\s*paintReadinessBanner\(\)\.catch/);
  assert.match(app, /i\.level === 'critical' && i\.id !== 'accounts' && i\.id !== 'provider'/, 'the two states with their own banners are not doubled');
  const users = read('users.html');
  assert.match(users, /id="invite-readiness"/);
  assert.match(users, /fetch\('\/api\/readiness'/);
  const sdk = read('lib/sdk-chat.js');
  assert.match(sdk, /function sandboxWithheldNotice\(\)[\s\S]*Install Docker Desktop for Mac[\s\S]*Setup checklist/);
  assert.match(sdk, /if \(sandboxWithheld\) sendSSE\(res, makeChunk\(sandboxWithheldNotice\(\), sdkModel\)\);/);
  assert.match(sdk, /if \(sseRes\) sendSSE\(sseRes, makeChunk\(sandboxWithheldNotice\(\), 'gateway'\)\);/, 'gateway agents are told too');
});

test('agents on ChatGPT with Codex signed out: critical, with the command that fixes it; signed in or no such agents: quiet', async () => {
  const base = { hasUsers: () => true, setupNeeded: () => false, hasSdkCredentials: () => true, sandboxStatus: async () => ({ docker: true, imageReady: true }), fetchStatus: async () => ({ renderer: true, pdftotext: true }), searchChain: () => ['perplexity'], supervisor: () => 'systemd', exposed: () => false };
  const agents = async () => [{ name: 'maestro', model: 'codex-cli/gpt-x' }];
  const out = await createReadiness({ ...base, agents, hasCodexSignIn: async () => false }).check();
  assert.strictEqual(byId(out, 'chatgpt-signin').level, 'critical');
  assert.match(byId(out, 'chatgpt-signin').title, /1 agent\(s\) use ChatGPT through Codex/);
  assert.match(JSON.stringify(byId(out, 'chatgpt-signin')), /mymaestro connect chatgpt/);
  assert.strictEqual(byId(await createReadiness({ ...base, agents, hasCodexSignIn: async () => true }).check(), 'chatgpt-signin'), undefined);
  assert.strictEqual(byId(await createReadiness({ ...base, agents: async () => [{ name: 'a', model: 'claude-sdk/x' }], hasCodexSignIn: () => false }).check(), 'chatgpt-signin'), undefined);
});

test('the memory check\'s line joins the checklist with its link to Settings → Status → Memory', async () => {
  const r = await createReadiness({
    platform: 'linux', hasUsers: () => true, listUsers: () => [{ role: 'admin', totpEnabled: true, login: 'a' }], setupNeeded: () => false, hasSdkCredentials: () => true,
    sandboxStatus: async () => ({ docker: true, imageReady: true }), fetchStatus: async () => ({ renderer: true, pdftotext: true }),
    searchChain: () => ['brave'], supervisor: () => 'systemd',
    memoryItems: () => [{ id: 'memory', level: 'warn', title: '1 agent needs attention for memory', detail: 'Doc: some records aren\'t loading.', fix: 'Settings → Status → Memory says what each one needs.', action: { label: 'Open Memory', href: '/?memory=1' } }],
  }).check();
  assert.deepStrictEqual([byId(r, 'memory').level, byId(r, 'memory').action.href, r.warnings], ['warn', '/?memory=1', 1]);
  const broken = await createReadiness({ memoryItems: () => { throw new Error('no file'); }, hasUsers: () => true, sandboxStatus: async () => ({ docker: true, imageReady: true }) }).check();
  assert.strictEqual(byId(broken, 'memory'), undefined, 'a check that fails adds nothing and stops nothing');
});


test('admin two-factor optional: the totp warning becomes an info item; required output is unchanged', async () => {
  const mk = (admins, setting) => createReadiness({
    platform: 'linux', hasUsers: () => true, listUsers: () => admins, getSetting: (k) => (k === 'requireAdmin2fa' ? setting : undefined),
  }).check();
  const off = { login: 'owner', role: 'admin', totpEnabled: false };
  const on = { login: 'sam', role: 'admin', totpEnabled: true };
  const opt = await mk([off, on], false);
  assert.strictEqual(byId(opt, 'totp'), undefined);
  assert.strictEqual(byId(opt, 'admin-2fa-optional').level, 'info');
  assert.strictEqual(byId(opt, 'admin-2fa-optional').title, 'Two-factor sign-in is optional for admins');
  assert.strictEqual(byId(opt, 'admin-2fa-optional').fix, 'Settings, Security');
  const allOn = await mk([on], false);
  assert.strictEqual(byId(allOn, 'admin-2fa-optional'), undefined);
  assert.strictEqual(byId(allOn, 'accounts').level, 'ok');
  for (const v of [undefined, true, 'false', null]) {
    const r = await mk([off], v);
    assert.strictEqual(byId(r, 'totp').level, 'warn');
    assert.strictEqual(byId(r, 'totp').title, '1 admin account(s) without two-factor');
    assert.strictEqual(byId(r, 'admin-2fa-optional'), undefined);
  }
});
